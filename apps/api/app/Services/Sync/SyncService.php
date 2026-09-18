<?php

namespace App\Services\Sync;

use App\Contracts\Repositories\SyncRepository;
use App\Contracts\Repositories\UserRepository;
use App\Enums\SyncResource;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Personal sync: rows up, rows down, no merge algorithm between them.
 *
 * Single-writer data cannot really conflict (PLAN.md §0), so this is a row union
 * plus one tie-break. What it must never do is *lose* a row silently, which is
 * why the revision counter, the page boundary and the append-only rule each have
 * a test of their own.
 */
final readonly class SyncService
{
    public const MAX_ROWS = 500;

    /** Roughly Phase 0: a review cannot have happened before the product did. */
    private const EPOCH_MS = 1_700_000_000_000;

    public function __construct(
        private SyncRepository $sync,
        private UserRepository $users,
    ) {}

    /**
     * Everything above this device's cursor, oldest change first.
     *
     * Revisions come from one counter per account, so they order writes across
     * all six tables rather than within one. That is what makes a single cursor
     * enough: a page can carry a deck, the notes that moved into it and the
     * reviews of those notes, in the order they actually happened.
     *
     * The cap is on **total rows**, not rows per table — a 20,000-note import
     * would otherwise return 20,000 notes beside six decks and call it a page.
     *
     * @return array{changes: array<string, list<array<string, mixed>>>, next_cursor: int|null, has_more: bool}
     */
    public function pull(User $user, int $cursor, int $limit = self::MAX_ROWS): array
    {
        $limit = max(1, min($limit, self::MAX_ROWS));

        $rows = [];
        foreach (SyncResource::all() as $resource) {
            foreach ($this->sync->changedSince($user, $resource, $cursor, $limit) as $row) {
                $rows[] = ['resource' => $resource, 'revision' => (int) $row->revision, 'row' => $row];
            }
        }

        usort($rows, fn (array $a, array $b) => $a['revision'] <=> $b['revision']);
        $hasMore = count($rows) > $limit;
        $page = array_slice($rows, 0, $limit);

        $changes = array_fill_keys(array_map(fn (SyncResource $r) => $r->value, SyncResource::all()), []);
        foreach ($page as $entry) {
            $changes[$entry['resource']->value][] = $this->present($entry['resource'], $entry['row']);
        }

        $last = $page === [] ? null : (int) $page[array_key_last($page)]['revision'];

        return ['changes' => $changes, 'next_cursor' => $last, 'has_more' => $hasMore];
    }

    /**
     * Apply what a device has been holding.
     *
     * Reviews are inserted if absent and never updated — the log is append-only
     * and the ids are client-generated, so a retried push is idempotent for free.
     * Content is last-write-wins on `client_updated_at`, and a row that did not
     * actually change gets no new revision, because re-pushing an unchanged
     * collection must not wake every other device up.
     *
     * ponytail: last-write-wins is row-level, so two offline edits to *different
     * fields of the same note* keep only the later note. PLAN.md asks for
     * per-field, which needs a `field_updated_at` map on both sides; Phase 9's
     * CRDT is the real answer for genuine co-editing. Upgrade here if
     * single-user multi-device editing turns out to collide in practice.
     *
     * @param  array<string, list<array<string, mixed>>>  $payload
     * @return array{applied: array<string, int>, skipped: array<string, list<string>>}
     */
    public function push(User $user, array $payload): array
    {
        return DB::transaction(function () use ($user, $payload): array {
            $applied = [];
            $skipped = [];

            foreach (SyncResource::all() as $resource) {
                $rows = $payload[$resource->value] ?? [];
                if ($rows === []) {
                    continue;
                }

                $result = $resource->isAppendOnly()
                    ? $this->appendOnly($user, $resource, $rows)
                    : $this->lastWriteWins($user, $resource, $rows);

                // Zero counts are left out: `applied` answers "what changed",
                // and a list of noughts is noise for the client to filter.
                if ($result['applied'] > 0) {
                    $applied[$resource->value] = $result['applied'];
                }
                if ($result['skipped'] !== []) {
                    $skipped[$resource->value] = $result['skipped'];
                }
            }

            return ['applied' => $applied, 'skipped' => $skipped];
        });
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @return array{applied: int, skipped: list<string>}
     */
    private function appendOnly(User $user, SyncResource $resource, array $rows): array
    {
        $keyed = $this->keyBy($resource, $rows);
        $present = array_keys($this->sync->existing($user, $resource, array_keys($keyed)));
        $fresh = array_diff_key($keyed, array_flip($present));

        if ($fresh === []) {
            return ['applied' => 0, 'skipped' => array_values($present)];
        }

        $now = Carbon::now();
        $nowMs = $now->getTimestampMs();
        $revision = $this->users->allocateRevisions($user, count($fresh));
        $insert = [];

        foreach ($fresh as $row) {
            $insert[] = [
                ...$this->writableOnly($resource, $row),
                'user_id' => $user->id,
                // The client's clock decides the order a person answered in; the
                // server's decides anything the server rules on.
                'client_ts' => $this->clamp(
                    $row['client_ts'] ?? $nowMs,
                    $nowMs,
                    (bool) ($row['imported'] ?? false),
                ),
                'server_received_at' => $nowMs,
                'revision' => $revision++,
                'created_at' => $now,
            ];
        }

        return [
            'applied' => $this->sync->insertMany($user, $resource, $insert),
            'skipped' => array_values($present),
        ];
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @return array{applied: int, skipped: list<string>}
     */
    private function lastWriteWins(User $user, SyncResource $resource, array $rows): array
    {
        $keyed = $this->keyBy($resource, $rows);
        $existing = $this->sync->existing($user, $resource, array_keys($keyed));

        $winners = [];
        $skipped = [];

        foreach ($keyed as $id => $row) {
            $incoming = (int) ($row['client_updated_at'] ?? 0);
            $current = $existing[$id] ?? null;

            // Strictly newer. An equal timestamp is the same write arriving
            // twice, and re-stamping it would wake every other device for
            // nothing.
            if ($current && (int) $current->client_updated_at >= $incoming) {
                $skipped[] = (string) $id;

                continue;
            }
            $winners[$id] = $row;
        }

        if ($winners === []) {
            return ['applied' => 0, 'skipped' => $skipped];
        }

        $revision = $this->users->allocateRevisions($user, count($winners));
        $now = Carbon::now();
        $attributes = [];

        foreach ($winners as $id => $row) {
            $attributes[$id] = [
                ...$this->writableOnly($resource, $row),
                'user_id' => $user->id,
                'client_updated_at' => (int) $row['client_updated_at'],
                'revision' => $revision++,
                'deleted_at' => ($row['deleted'] ?? false) ? $now : null,
            ];
        }

        return [
            'applied' => $this->sync->upsertMany($user, $resource, $attributes),
            'skipped' => $skipped,
        ];
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @return array<string, array<string, mixed>>
     */
    private function keyBy(SyncResource $resource, array $rows): array
    {
        $keyed = [];
        foreach ($rows as $row) {
            $keyed[$row[$resource->key()]] = $row;
        }

        return $keyed;
    }

    /**
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    private function writableOnly(SyncResource $resource, array $row): array
    {
        $out = [];
        foreach ($resource->writable() as $column) {
            if (array_key_exists($column, $row)) {
                // Passed through unchanged. Encoding an array here looked
                // harmless and was not: `upsertMany` goes through
                // `updateOrCreate`, so the model's `array` cast encodes it a
                // second time and the column ends up holding a JSON string of
                // JSON. A pull then hands the client a string where it expects
                // an object, for `notes.fields` and every JSON column on
                // `note_types`. The append-only insert path has no JSON columns.
                $out[$column] = $row[$column];
            }
        }

        return $out;
    }

    /**
     * The row as the client's own SQLite holds it, plus what only the server
     * knows: where it sits in the revision order, and whether it is a tombstone.
     *
     * @return array<string, mixed>
     */
    private function present(SyncResource $resource, mixed $row): array
    {
        $out = ['revision' => (int) $row->revision];

        foreach ($resource->writable() as $column) {
            $out[$column] = $row->{$column};
        }

        if ($resource->isAppendOnly()) {
            $out['server_received_at'] = (int) $row->server_received_at;

            return $out;
        }

        $out['client_updated_at'] = (int) $row->client_updated_at;
        // A delete has to be something a pull can report: a row that simply
        // vanished is invisible to every device that was offline when it
        // happened, and comes back on their next push.
        $out['deleted'] = $row->deleted_at !== null;

        return $out;
    }

    /**
     * Phone clocks are wrong and people change timezones mid-flight.
     *
     * Clamped rather than replaced: the device's claim is still the best
     * evidence of the order things happened in (PLAN.md §2.6).
     *
     * An **imported** answer skips the floor. A real .apkg carries answers from
     * 2015, and this app exists to keep that history — flooring them at the
     * epoch would compress a decade of studying onto one afternoon and hand
     * FSRS a story that never happened. The future is still capped either way:
     * no answer was given after now.
     */
    private function clamp(int|string $value, int $now, bool $imported = false): int
    {
        $value = min((int) $value, $now);

        return $imported ? $value : max(self::EPOCH_MS, $value);
    }
}
