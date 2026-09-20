<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\DocSnapshot;
use App\Models\DocUpdate;
use App\Services\Collaboration\DocumentService;
use Illuminate\Console\Command;

/**
 * Nightly housekeeping for the collaborative edit log.
 *
 * **What this command cannot do, and why.** It cannot compact a document.
 * Compaction means merging Yjs updates into one state, merging Yjs updates
 * means running Yjs, and there is no Yjs in PHP — the same constraint that
 * makes the log opaque in the first place (PHASES §9). Snapshots are therefore
 * produced by clients: the API tells a connected client `should_compact` and it
 * posts the merged document back.
 *
 * So this does the two things a server *can* do about an unbounded log:
 *
 * 1. **Prune.** Delete updates a snapshot already covers. Normally the snapshot
 *    endpoint does this in the same transaction, and this is the safety net for
 *    the run that was interrupted between writing the snapshot and deleting the
 *    rows it superseded.
 * 2. **Report.** Name the documents whose log has grown past the threshold and
 *    that no client has opened since — the ones that will hand a slow first
 *    load to whoever opens them next. A number nobody prints is a number nobody
 *    acts on.
 *
 * Scheduled in `routes/console.php`.
 */
class CompactDocuments extends Command
{
    protected $signature = 'collab:compact {--threshold= : Updates before a log is called long}';

    protected $description = 'Prune superseded collaboration updates and report logs waiting on a client snapshot';

    public function handle(): int
    {
        $threshold = (int) ($this->option('threshold') ?: DocumentService::COMPACT_AFTER);
        $pruned = 0;

        foreach (DocSnapshot::query()->cursor() as $snapshot) {
            $pruned += DocUpdate::query()
                ->where('deck_id', $snapshot->deck_id)
                ->where('seq', '<=', $snapshot->up_to_seq)
                ->delete();
        }

        $long = DocUpdate::query()
            ->selectRaw('deck_id, COUNT(*) AS updates')
            ->groupBy('deck_id')
            ->havingRaw('COUNT(*) >= ?', [$threshold])
            ->orderByRaw('COUNT(*) DESC')
            ->limit(50)
            ->get();

        $this->info("Pruned {$pruned} superseded update(s).");

        if ($long->isEmpty()) {
            $this->info('No document is waiting on a snapshot.');

            return self::SUCCESS;
        }

        $this->warn($long->count().' document(s) past '.$threshold.' updates, waiting for a client to compact:');
        $this->table(
            ['deck', 'updates'],
            $long->map(fn ($row): array => [$row->deck_id, $row->updates])->all(),
        );

        return self::SUCCESS;
    }
}
