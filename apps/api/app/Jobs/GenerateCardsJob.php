<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Exceptions\ApiException;
use App\Models\AiJob;
use App\Services\Ai\GenerateService;
use App\Services\Ai\Ledger;
use App\Services\Ai\SourceText;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Extract → chunk → generate → grade, off the request.
 *
 * Shaped like `ImportApkgJob` because it is the same shape of problem, with one
 * difference that changes everything about the error handling: **every attempt
 * here costs real money.**
 *
 * So `tries = 1`, and for a stronger reason than the importer's. A deck that
 * killed the worker once will kill it three times — and unlike an import, each
 * of those three attempts bills for every call it made before dying. The only
 * retry anywhere in this subsystem is Anthropic's own 429, handled inside the
 * gateway where it can still be counted.
 *
 * The job stops the moment the allowance runs out and reports `partial` with
 * whatever it produced. It does not fail: forty good cards from a document that
 * would have yielded sixty is a useful outcome, and throwing them away because
 * the budget ran out mid-run would be the worse answer.
 */
class GenerateCardsJob implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public int $timeout = 900;

    public function __construct(public readonly AiJob $aiJob) {}

    public function handle(SourceText $source, GenerateService $generator, Ledger $ledger): void
    {
        $job = $this->aiJob->fresh();
        if ($job === null || $job->status !== AiJob::STATUS_QUEUED) {
            return;
        }

        $user = $job->user;
        $job->update(['status' => AiJob::STATUS_RUNNING, 'stage' => 'extracting']);

        try {
            $path = $job->source_path ? Storage::path($job->source_path) : null;
            if ($path === null || ! is_file($path)) {
                throw new \RuntimeException('The uploaded file is gone.');
            }

            $chunks = $source->chunks($source->extract($path, $job->source_name, mime_content_type($path) ?: 'text/plain'));

            $job->update([
                'stage' => 'generating',
                'total' => count($chunks),
                'done' => 0,
            ]);

            $stoppedEarly = false;

            foreach ($chunks as $i => $chunk) {
                // Re-checked per chunk rather than once at dispatch. One upload
                // is eight generation calls plus the grading that follows each,
                // and a check that passed at the start stopped being true at
                // the second one.
                if ($ledger->remaining($user) <= 0) {
                    $stoppedEarly = true;
                    break;
                }

                try {
                    $generator->fromChunk($user, $job, $chunk);
                } catch (ApiException $e) {
                    // Out of allowance, refused, or upstream trouble. Whatever
                    // has been produced so far is kept and reported.
                    $stoppedEarly = true;
                    $job->update(['error' => $e->getMessage()]);
                    break;
                }

                $job->update(['done' => $i + 1]);
            }

            $job->update([
                'status' => $stoppedEarly ? AiJob::STATUS_PARTIAL : AiJob::STATUS_DONE,
                'stage' => 'done',
            ]);
        } catch (Throwable $e) {
            $job->update([
                'status' => AiJob::STATUS_FAILED,
                'error' => $e instanceof ApiException ? $e->getMessage() : 'That source could not be read.',
            ]);

            if (! $e instanceof ApiException) {
                report($e);
            }
        } finally {
            // The upload is deleted whichever way this ended, exactly as
            // `import_jobs` does. A medical student's source material is the
            // most sensitive thing in the product and it has no reason to
            // outlive the job that read it.
            $this->discardSource($job->fresh());
        }
    }

    public function failed(Throwable $e): void
    {
        $job = $this->aiJob->fresh();
        $job?->update(['status' => AiJob::STATUS_FAILED, 'error' => 'The job stopped unexpectedly.']);
        $this->discardSource($job);
    }

    private function discardSource(?AiJob $job): void
    {
        if ($job?->source_path) {
            Storage::delete($job->source_path);
            $job->update(['source_path' => null]);
        }
    }
}
