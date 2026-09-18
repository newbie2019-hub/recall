<?php

namespace App\Http\Controllers\Api\V1;

use App\Contracts\Repositories\DeviceRepository;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\SyncPullRequest;
use App\Http\Requests\Api\V1\SyncPushRequest;
use App\Services\Sync\SyncService;
use Illuminate\Http\JsonResponse;

/**
 * Two endpoints, because personal data has exactly two directions and no merge
 * algorithm between them (PLAN.md §0, Conflict 1).
 */
class SyncController extends Controller
{
    use RespondsWithApi;

    public function __construct(
        private readonly SyncService $sync,
        private readonly DeviceRepository $devices,
    ) {}

    /**
     * The cursor comes from the request, not from the stored device row: a
     * client that failed to apply a page must be able to ask for it again, and a
     * server-held cursor would already have moved past it.
     */
    public function pull(SyncPullRequest $request): JsonResponse
    {
        $result = $this->sync->pull($request->user(), $request->cursor(), $request->limit());

        if ($result['next_cursor'] !== null) {
            $this->devices->advanceCursor(
                $request->user(),
                $request->user()->currentAccessToken()->id,
                $result['next_cursor'],
            );
        }

        return $this->page($result['changes'], $result['next_cursor'], $result['has_more']);
    }

    public function push(SyncPushRequest $request): JsonResponse
    {
        return $this->ok($this->sync->push($request->user(), $request->payload()));
    }
}
