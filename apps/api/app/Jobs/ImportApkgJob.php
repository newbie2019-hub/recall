<?php

namespace App\Jobs;

use App\Models\ImportJob;
use App\Services\Anki\ImportService;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Unzip → zstd → read → write, off the request.
 *
 * A 20,000-note deck is minutes of work and hundreds of megabytes of media; an
 * HTTP request that did it would hit every timeout between the browser and PHP.
 * The client polls the `import_jobs` row instead (PHASES.md §5).
 */
class ImportApkgJob implements ShouldQueue
{
    use Queueable;

    /**
     * Once. The import is idempotent — everything matches on guid, and the
     * review log deduplicates on card and instant — so a retry would be *safe*;
     * it is refused because a deck that killed the worker once will kill it
     * three times, and the person is better served by the error.
     */
    public int $tries = 1;

    public int $timeout = 900;

    public function __construct(public readonly ImportJob $importJob) {}

    public function handle(ImportService $importer): void
    {
        $job = $this->importJob->fresh();
        if ($job === null || $job->status !== 'queued') {
            return;
        }

        $job->update(['status' => 'running', 'stage' => 'reading']);
        $written = 0;

        try {
            // ponytail: `Storage::path` needs a local disk, which is what
            // FILESYSTEM_DISK is today. On S3 this becomes a stream to a temp
            // file first — ZipArchive and pdo_sqlite both open paths, not URLs.
            $report = $importer->import(
                $job->user,
                Storage::path($job->path),
                function (string $stage, int $done, int $total) use ($job, &$written): void {
                    // One UPDATE per 50 items, not per file: a 4,000-image deck
                    // would otherwise spend more time reporting than importing.
                    if ($stage !== $job->stage || $done - $written >= 50 || $done >= $total) {
                        $job->update(['stage' => $stage, 'done' => $done, 'total' => $total]);
                        $written = $done;
                    }
                },
            );

            $job->update(['status' => 'done', 'stage' => 'done', 'report' => $report]);
        } catch (Throwable $e) {
            report($e);
            $job->update(['status' => 'failed', 'error' => $e->getMessage()]);
        } finally {
            // The upload has done its job either way, and a failed 200 MB
            // import that keeps its file is a disk that fills quietly.
            Storage::delete($job->path);
        }
    }

    /**
     * The paths `handle()` never returns from: a timeout, or a worker killed
     * mid-import. Without this the row sits at "running" forever and the client
     * polls a job that is not coming back.
     */
    public function failed(?Throwable $e): void
    {
        $this->importJob->fresh()?->update([
            'status' => 'failed',
            'error' => $e?->getMessage() ?? 'The import worker stopped before it finished',
        ]);

        Storage::delete($this->importJob->path);
    }
}
