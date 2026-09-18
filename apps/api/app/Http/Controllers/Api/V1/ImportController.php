<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Resources\ImportJobResource;
use App\Jobs\ImportApkgJob;
use App\Models\ImportJob;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Upload an `.apkg`, then poll it.
 *
 * A server-side import lands in MySQL and therefore syncs to *every* device,
 * where the browser's importer only ever reaches the device that ran it
 * (PHASES.md §5). The browser one stays: it is the path that works signed out
 * and on a plane.
 */
class ImportController extends Controller
{
    use RespondsWithApi;

    /**
     * 500 MB. A shared anatomy deck with full-page plates runs to a few hundred;
     * past this it is someone's whole collection and belongs in a support
     * conversation, not in a queue worker.
     */
    private const MAX_KB = 512000;

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            // `extensions` checks the name and `file` checks the upload itself.
            // Neither proves it is an Anki deck — only opening it does, which is
            // the worker's job and where the readable error comes from.
            'file' => ['required', 'file', 'extensions:apkg,zip', 'max:'.self::MAX_KB],
        ]);

        $job = ImportJob::create([
            'user_id' => $request->user()->id,
            'original_name' => $validated['file']->getClientOriginalName(),
            'path' => $validated['file']->store('imports/'.$request->user()->id),
            'status' => 'queued',
            'stage' => 'reading',
        ]);

        ImportApkgJob::dispatch($job);

        return $this->created(new ImportJobResource($job));
    }

    /**
     * Scoped to the signed-in account rather than resolved by id alone: a job id
     * is a uuid, but "unguessable" is not an authorisation rule.
     */
    public function show(Request $request, string $importJob): JsonResponse
    {
        $job = ImportJob::query()
            ->where('user_id', $request->user()->id)
            ->findOrFail($importJob);

        return $this->ok(new ImportJobResource($job));
    }
}
