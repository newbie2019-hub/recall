<?php

declare(strict_types=1);

namespace App\Services\Collaboration;

use App\Enums\ApiErrorCode;
use App\Events\DocUpdated;
use App\Exceptions\ApiException;
use App\Models\Deck;
use App\Models\DocSnapshot;
use App\Models\DocUpdate;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Store an update, hand the log back in order, and accept a compaction.
 *
 * Three operations, and none of them decodes anything. If a method here ever
 * needs to know what is inside a payload, the design has moved and PHASES §9's
 * "Laravel stores updates as opaque binary blobs" has stopped being true.
 */
final readonly class DocumentService
{
    /**
     * One update is a keystroke or a few, debounced. A megabyte is not an edit,
     * it is a paste of a document or somebody probing the endpoint.
     */
    public const MAX_UPDATE_BYTES = 1_048_576;

    /** A whole document. Larger than an update because it is every note in a deck. */
    public const MAX_SNAPSHOT_BYTES = 16_777_216;

    /**
     * How many updates may pile up behind a snapshot before clients are asked to
     * cut a new one. Low enough that a joiner's replay stays quick, high enough
     * that a typing session does not spend its time compacting.
     */
    public const COMPACT_AFTER = 500;

    /**
     * Everything a client needs to reach the current state: the snapshot, if
     * there is one, then every update after it.
     *
     * `since` lets a client that was already connected resume from where it
     * stopped instead of re-reading the document — the reconnect path, and the
     * one that has to be cheap because a flaky connection takes it repeatedly.
     *
     * @return array{snapshot: ?string, snapshot_seq: int, updates: list<array{seq: int, payload: string}>, cursor: int, should_compact: bool}
     */
    public function state(Deck $deck, int $since = 0): array
    {
        $snapshot = DocSnapshot::query()->find($deck->id);

        // A resuming client already holds everything up to `since`; a fresh one
        // takes the snapshot and everything after it. Both then read the same
        // tail, so there is one query here rather than two paths.
        $from = $since > 0 ? $since : (int) ($snapshot?->up_to_seq ?? 0);
        $sendSnapshot = $since <= 0 && $snapshot !== null;

        $updates = DocUpdate::query()
            ->where('deck_id', $deck->id)
            ->where('seq', '>', $from)
            ->orderBy('seq')
            ->get(['seq', 'payload']);

        $cursor = (int) ($updates->last()->seq ?? $from);

        return [
            'snapshot' => $sendSnapshot ? $snapshot->payload : null,
            'snapshot_seq' => (int) ($snapshot?->up_to_seq ?? 0),
            'updates' => $updates->map(fn (DocUpdate $u): array => [
                'seq' => (int) $u->seq,
                'payload' => $u->payload,
            ])->all(),
            'cursor' => $cursor,
            // Asked of the client rather than done here, because compaction
            // means running Yjs and there is none in PHP. See the migration.
            'should_compact' => $this->pendingUpdates($deck) >= self::COMPACT_AFTER,
        ];
    }

    /**
     * Record an edit and tell everybody else about it.
     *
     * Persist first, broadcast second, and never the other way round: a
     * broadcast that outran its own row would be an edit every connected client
     * has applied and a reconnecting one can never find.
     */
    public function append(Deck $deck, User $actor, string $payload, ?string $socketId = null): DocUpdate
    {
        $this->guardSize($payload, self::MAX_UPDATE_BYTES, 'update');

        $update = DocUpdate::query()->create([
            'deck_id' => $deck->id,
            'actor_id' => $actor->id,
            'payload' => $payload,
            'created_at' => now(),
        ]);

        $event = new DocUpdated($deck->id, (int) $update->seq, $payload, $actor->id);

        // `toOthers` needs the sender's socket id, which the client sends as
        // X-Socket-ID. Without it the sender receives its own update back —
        // harmless, because applying a Yjs update twice is a no-op, but it
        // doubles the traffic of a typing session for no reason.
        if ($socketId !== null && $socketId !== '') {
            $event->socket = $socketId;
        }

        broadcast($event)->toOthers();

        return $update;
    }

    /**
     * Accept a client-produced compaction and drop what it supersedes.
     *
     * `up_to_seq` is checked against this deck's own log: a snapshot claiming to
     * cover updates that do not exist here yet would delete nothing and then be
     * handed to a joiner as though it were complete.
     */
    public function compact(Deck $deck, User $actor, string $payload, int $upToSeq): DocSnapshot
    {
        $this->guardSize($payload, self::MAX_SNAPSHOT_BYTES, 'snapshot');

        $existing = DocSnapshot::query()->find($deck->id);

        // The furthest this document has ever got — *not* `max(seq)` on its own.
        // A previous compaction deleted the rows it covered, so after one the
        // log's own maximum is lower than the state everybody is holding, and a
        // second snapshot would be rejected as claiming updates that "do not
        // exist". The snapshot's own watermark is the memory of those rows.
        $latest = max(
            (int) DocUpdate::query()->where('deck_id', $deck->id)->max('seq'),
            (int) ($existing?->up_to_seq ?? 0),
        );

        if ($upToSeq > $latest) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'That snapshot claims updates this deck does not have.',
            );
        }

        // An older snapshot arriving late — two clients compacted at once — is
        // not an error and must not move the document backwards.
        if ($existing !== null && $existing->up_to_seq >= $upToSeq) {
            return $existing;
        }

        return DB::transaction(function () use ($deck, $actor, $payload, $upToSeq): DocSnapshot {
            $snapshot = DocSnapshot::query()->updateOrCreate(
                ['deck_id' => $deck->id],
                ['payload' => $payload, 'up_to_seq' => $upToSeq, 'actor_id' => $actor->id],
            );

            DocUpdate::query()
                ->where('deck_id', $deck->id)
                ->where('seq', '<=', $upToSeq)
                ->delete();

            return $snapshot;
        });
    }

    /** Updates not yet covered by a snapshot — what a new joiner has to replay. */
    public function pendingUpdates(Deck $deck): int
    {
        return DocUpdate::query()->where('deck_id', $deck->id)->count();
    }

    private function guardSize(string $payload, int $limit, string $what): void
    {
        if (strlen($payload) > $limit) {
            throw new ApiException(
                ApiErrorCode::PayloadTooLarge,
                'That '.$what.' is too large to accept.',
            );
        }
    }
}
