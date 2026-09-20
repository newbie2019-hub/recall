<?php

declare(strict_types=1);

namespace App\Services\Ai;

use App\Enums\AiFeature;
use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Models\AiUsage;
use App\Models\User;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Throwable;

/**
 * The only place in this codebase that calls Anthropic.
 *
 * **It cannot return without writing a ledger row.** That single rule is the
 * whole metering architecture (AI.md §3.1), and every other guarantee — the
 * number in Settings, the quota, the ability to answer "what did we charge in
 * March" — is downstream of it. A feature that wants the model calls this with
 * an {@see AiFeature}; nothing else touches the wire and nothing else computes
 * cost.
 *
 * No SDK. Laravel's HTTP client is already here and the API is one POST, so a
 * dependency would buy a retry policy we do not want (see below) and an object
 * model for two fields.
 *
 * The failure modes it exists to survive, each one a real way to lose money
 * quietly:
 *
 * - **A refusal is an HTTP 200.** `stop_reason: "refusal"` returns success with
 *   nothing usable, and `max_tokens` truncation returns half an answer at full
 *   price. Both bill, so both write a row — `status: refusal` / `truncated`.
 *   Recording only successes under-reports the bill by exactly the calls you
 *   most need to look at.
 * - **An exception after the response landed is a free charge.** The ledger
 *   write is in `finally`, not after the return: if the JSON parsed and the
 *   mapping then blew up, the money is already spent.
 * - **Retries bill twice.** `ImportApkgJob` sets `tries = 1` and says why; the
 *   same reasoning applies harder here, because each attempt is a real charge.
 *   A 429 is the one exception, and it is retried *here*, where it can still be
 *   counted correctly.
 * - **Hostile input.** Source text — an uploaded PDF, a cloned marketplace deck
 *   — goes in a *user* turn, clearly delimited as data, and never in the system
 *   prompt. The response shape is constrained by a `strict` tool, so the only
 *   thing the model can express is the schema's own fields. It cannot emit
 *   markup because the schema has nowhere to put markup (AI.md §6.8).
 */
final class Claude
{
    /** Anthropic's own rate limit, retried here where it can still be counted. */
    private const RATE_LIMIT_RETRIES = 2;

    public function __construct(private readonly Ledger $ledger) {}

    /** No key, no subsystem — and the app says so rather than failing later. */
    public static function configured(): bool
    {
        return (bool) config('ai.key');
    }

    /**
     * One call, one ledger row.
     *
     * @param  array<int, array<string, mixed>>  $messages
     * @param  array<string, mixed>|null  $tool  a `strict` tool, when the answer must have a shape
     * @return array<string, mixed> the assistant's structured result
     */
    public function call(
        User $user,
        AiFeature $feature,
        string $system,
        array $messages,
        ?array $tool = null,
        int $maxTokens = 1024,
        ?string $jobId = null,
        int $estimateMicros = 0,
    ): array {
        if (! self::configured()) {
            throw new ApiException(ApiErrorCode::AiUnavailable, 'AI features are not configured on this server.');
        }

        if ($user->ai_consent_at === null) {
            throw new ApiException(
                ApiErrorCode::AiConsentRequired,
                'Turn on AI features in Settings first — nothing is sent until you do.',
            );
        }

        // Checked per call, against the current spend. See AI.md §6.6: a quota
        // checked once per job is a quota that stopped existing at the second
        // call.
        if (! $this->ledger->canSpend($user, $estimateMicros)) {
            throw new ApiException(
                ApiErrorCode::AiQuotaExceeded,
                'You have used this month\'s AI allowance.',
            );
        }

        $model = $feature->model();
        $started = hrtime(true);

        $usage = ['input_tokens' => 0, 'cache_creation_input_tokens' => 0, 'cache_read_input_tokens' => 0, 'output_tokens' => 0];
        $status = 'error';
        $stopReason = null;
        $requestId = null;
        $result = [];
        $failure = null;

        try {
            $response = $this->send($model, $system, $messages, $tool, $maxTokens);
            $requestId = $response->header('request-id') ?: null;
            $body = $response->json() ?? [];

            // Read usage before anything else can throw. It is the one part of
            // the response that is true regardless of what the content says.
            $usage = array_merge($usage, is_array($body['usage'] ?? null) ? $body['usage'] : []);
            $stopReason = $body['stop_reason'] ?? null;

            if (! $response->successful()) {
                $status = 'error';
                $failure = new ApiException(
                    ApiErrorCode::AiUpstream,
                    'The model could not be reached. Nothing was charged to your allowance twice.',
                );
            } elseif ($stopReason === 'refusal') {
                $status = 'refusal';
                $failure = new ApiException(
                    ApiErrorCode::AiRefused,
                    'The model declined to answer that.',
                );
            } else {
                $status = $stopReason === 'max_tokens' ? 'truncated' : 'ok';
                $result = $this->extract($body, $tool);
            }
        } catch (ApiException $e) {
            $failure = $e;
        } catch (Throwable $e) {
            report($e);
            $failure = new ApiException(ApiErrorCode::AiUpstream, 'The model could not be reached.');
        } finally {
            // `finally`, not after the return: if the response landed and the
            // mapping then threw, the money is already spent and the row is the
            // only record of it.
            $this->record($user, $feature, $model, $usage, $status, $stopReason, $requestId, $jobId, $started);
        }

        if ($failure !== null) {
            throw $failure;
        }

        return $result;
    }

    /**
     * @param  array<int, array<string, mixed>>  $messages
     * @param  array<string, mixed>|null  $tool
     */
    private function send(string $model, string $system, array $messages, ?array $tool, int $maxTokens): Response
    {
        $payload = [
            'model' => $model,
            'max_tokens' => $maxTokens,
            // The system prompt carries instructions and never carries user
            // content. That separation is the structural half of the
            // prompt-injection guard.
            'system' => $system,
            'messages' => $messages,
        ];

        if ($tool !== null) {
            $payload['tools'] = [$tool];
            $payload['tool_choice'] = ['type' => 'tool', 'name' => $tool['name']];
        }

        $request = Http::baseUrl((string) config('ai.base_url'))
            ->timeout((int) config('ai.timeout', 60))
            ->withHeaders([
                'x-api-key' => (string) config('ai.key'),
                'anthropic-version' => (string) config('ai.version'),
            ])
            // Only a 429 is retried, and only here — a retry anywhere else is a
            // second real charge for the same work.
            ->retry(self::RATE_LIMIT_RETRIES, 1000, fn ($e, $r) => $r?->status() === 429, throw: false);

        return $request->post('/messages', $payload);
    }

    /**
     * The assistant's answer, as a structure rather than as prose.
     *
     * With a tool the answer *is* the tool input, which is the whole point:
     * the model has nowhere to put markup, a link or an instruction, because
     * the schema has no field for one.
     *
     * @param  array<string, mixed>  $body
     * @param  array<string, mixed>|null  $tool
     * @return array<string, mixed>
     */
    private function extract(array $body, ?array $tool): array
    {
        $content = is_array($body['content'] ?? null) ? $body['content'] : [];

        if ($tool !== null) {
            foreach ($content as $block) {
                if (($block['type'] ?? null) === 'tool_use' && is_array($block['input'] ?? null)) {
                    return $block['input'];
                }
            }

            throw new ApiException(ApiErrorCode::AiRefused, 'The model answered in the wrong shape.');
        }

        $text = '';
        foreach ($content as $block) {
            if (($block['type'] ?? null) === 'text') {
                $text .= $block['text'] ?? '';
            }
        }

        return ['text' => $text];
    }

    /**
     * @param  array<string, mixed>  $usage
     */
    private function record(
        User $user,
        AiFeature $feature,
        string $model,
        array $usage,
        string $status,
        ?string $stopReason,
        ?string $requestId,
        ?string $jobId,
        int $startedAt,
    ): void {
        // Anthropic's names, mapped once, here. `input_tokens` excludes the two
        // cache counts — see Pricing, where getting this wrong is the bug.
        $input = (int) ($usage['input_tokens'] ?? 0);
        $cacheWrite = (int) ($usage['cache_creation_input_tokens'] ?? 0);
        $cacheRead = (int) ($usage['cache_read_input_tokens'] ?? 0);
        $output = (int) ($usage['output_tokens'] ?? 0);

        try {
            AiUsage::query()->create([
                'id' => (string) Str::uuid(),
                'user_id' => $user->id,
                'feature' => $feature->value,
                'job_id' => $jobId,
                'model' => $model,
                'input_tokens' => $input,
                'cache_write_tokens' => $cacheWrite,
                'cache_read_tokens' => $cacheRead,
                'output_tokens' => $output,
                'cost_micros' => Pricing::cost($model, $input, $cacheWrite, $cacheRead, $output),
                'price_version' => (string) config('ai.price_version'),
                'status' => $status,
                'stop_reason' => $stopReason,
                'request_id' => $requestId,
                'latency_ms' => (int) ((hrtime(true) - $startedAt) / 1_000_000),
            ]);
        } catch (Throwable $e) {
            // A ledger write that fails must not also swallow the caller's
            // error. It is reported and the request continues to its own
            // outcome — but it is reported loudly, because this is the one
            // write in the subsystem that must not be silently lost.
            report($e);
        }
    }
}
