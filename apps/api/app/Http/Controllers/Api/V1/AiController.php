<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Services\Ai\ExplainService;
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
