<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Services\Ai\BriefService;
use App\Services\Ai\ExplainService;
use App\Services\Ai\GradeService;
use App\Services\Ai\Ledger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The AI surface: one feature, and the number that says what it cost.
 *
 * `GET /ai/usage` exists so the spend is *in the product* rather than only in
 * the database (AI.md §5). A subsystem that can spend money on a person's
 * behalf without showing them the total is one they are right not to trust —
 * and this is also the endpoint that proves the meter works, because it can be
 * read against the Anthropic console.
 */
class AiController extends Controller
{
    use RespondsWithApi;

    public function __construct(
        private readonly Ledger $ledger,
        private readonly ExplainService $explain,
        private readonly GradeService $grader,
        private readonly BriefService $briefer,
    ) {}

    public function usage(Request $request): JsonResponse
    {
        return $this->ok($this->ledger->summary($request->user()));
    }

    /**
     * Turn the subsystem on for this account, or off again.
     *
     * Explicit, one-time and revocable. A medical student's cards are the most
     * sensitive content in this product and its users chose an offline-first
     * app on purpose; nothing is sent anywhere until this is set (AI.md §6.10).
     */
    public function consent(Request $request): JsonResponse
    {
        $data = $request->validate(['enabled' => ['required', 'boolean']]);

        $request->user()
            ->forceFill(['ai_consent_at' => $data['enabled'] ? now() : null])
            ->save();

        return $this->ok($this->ledger->summary($request->user()->fresh()));
    }

    /**
     * Two paragraphs over the dashboard's own numbers.
     *
     * The figures are computed on the device and sent here; the model is never
     * asked to do arithmetic. A screen whose value is that its numbers are
     * trustworthy cannot have a model inventing one.
     */
    public function brief(Request $request): JsonResponse
    {
        $data = $request->validate([
            'figures' => ['required', 'array'],
        ]);

        return $this->ok($this->briefer->brief($request->user(), $data['figures']));
    }

    /**
     * The card doctor: grade cards that already exist.
     *
     * One call per batch, not one per card. The client pages a deck through
     * this and renders what comes back, which keeps the whole feature
     * stateless — there is no job, no queue and nothing to poll, because a
     * batch of twenty is a second or two and the client already knows which
     * cards it has not sent yet.
     */
    public function grade(Request $request): JsonResponse
    {
        $data = $request->validate([
            'cards' => ['required', 'array', 'min:1', 'max:'.GradeService::BATCH],
            'cards.*.id' => ['required', 'string', 'max:64'],
            'cards.*.fields' => ['required', 'array', 'min:1', 'max:8'],
            'cards.*.fields.*' => ['nullable', 'string', 'max:4000'],
        ]);

        $cards = array_map(fn (array $card): array => [
            'id' => (string) $card['id'],
            'fields' => array_map(fn ($v): string => (string) $v, $card['fields']),
        ], $data['cards']);

        return $this->ok(['verdicts' => $this->grader->grade($request->user(), $cards)]);
    }

    /**
     * One lapse, explained.
     *
     * The card is sent by the client rather than read from the server, because
     * the collection lives on the device — the server holds a sync log, not a
     * rendered card. That also keeps the feature working for a card that has
     * not synced yet.
     */
    public function explain(Request $request): JsonResponse
    {
        $data = $request->validate([
            'fields' => ['required', 'array', 'min:1', 'max:12'],
            'fields.*' => ['nullable', 'string', 'max:4000'],
            'deck' => ['nullable', 'string', 'max:120'],
            'lapses' => ['nullable', 'integer', 'min:0', 'max:9999'],
        ]);

        return $this->ok($this->explain->explain(
            $request->user(),
            array_map(fn ($v): string => (string) $v, $data['fields']),
            $data['deck'] ?? '',
            (int) ($data['lapses'] ?? 0),
        ));
    }
}
