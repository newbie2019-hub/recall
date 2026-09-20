<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Models\Deck;
use App\Services\Collaboration\DocumentService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The collaborative document: read the log, append to it, compact it.
 *
 * Three endpoints that between them never decode a payload. Read needs `view`,
 * append needs `update`, and compaction needs `update` too — a viewer who could
 * post a snapshot could replace the document with anything at all, which is the
 * one way a read-only role could still destroy a deck.
 */
class DocumentController extends Controller
{
    use RespondsWithApi;

    public function __construct(private readonly DocumentService $documents) {}

    /**
     * The state a client needs to open the deck, or to resume after a drop.
     *
     * `since` is the client's cursor. Zero means "I have nothing", which is
     * also what a first open sends.
     */
    public function show(Request $request, Deck $deck): JsonResponse
    {
        $this->allow($request, 'view', $deck);

        return $this->ok($this->documents->state($deck, max(0, $request->integer('since'))));
    }

    /**
     * Append one update and rebroadcast it.
     *
     * The base64 is validated as base64 and not as anything else. It is the
     * only inspection this server performs on a payload, and it exists to stop
     * the column filling with data the client will choke on rather than to
     * understand the edit.
     */
    public function store(Request $request, Deck $deck): JsonResponse
    {
        $this->allow($request, 'update', $deck);

        $validated = $request->validate([
            'payload' => ['required', 'string'],
        ]);

        $this->assertBase64($validated['payload']);

        $update = $this->documents->append(
            $deck,
            $request->user(),
            $validated['payload'],
            $request->header('X-Socket-ID'),
        );

        return $this->created([
            'seq' => (int) $update->seq,
            'should_compact' => $this->documents->pendingUpdates($deck) >= DocumentService::COMPACT_AFTER,
        ]);
    }

    /**
     * A client hands back the whole document, compacted.
     *
     * Why a client and not this server: compacting Yjs updates means running
     * Yjs, and there is none in PHP — the same reason the log is opaque in the
     * first place (PHASES §9).
     */
    public function compact(Request $request, Deck $deck): JsonResponse
    {
        $this->allow($request, 'update', $deck);

        $validated = $request->validate([
            'payload' => ['required', 'string'],
            'up_to_seq' => ['required', 'integer', 'min:1'],
        ]);

        $this->assertBase64($validated['payload']);

        $snapshot = $this->documents->compact(
            $deck,
            $request->user(),
            $validated['payload'],
            (int) $validated['up_to_seq'],
        );

        return $this->ok(['up_to_seq' => (int) $snapshot->up_to_seq]);
    }

    private function allow(Request $request, string $ability, Deck $deck): void
    {
        if (! $request->user()->can($ability, $deck)) {
            throw new ApiException(
                ApiErrorCode::Forbidden,
                $ability === 'view'
                    ? 'That deck is not shared with you.'
                    : 'You have read-only access to this deck.',
            );
        }
    }

    private function assertBase64(string $payload): void
    {
        if (base64_decode($payload, true) === false) {
            throw new ApiException(ApiErrorCode::ValidationFailed, 'That update is not base64.');
        }
    }
}
