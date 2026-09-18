<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Contracts\Repositories\ListingRepository;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Resources\ListingResource;
use App\Models\Listing;
use App\Models\ListingReport;
use App\Services\Marketplace\ModerationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The queue, and the two decisions that come out of it.
 *
 * The whole controller is behind `can:moderate` in routes/api.php rather than a
 * check per method: one route group is a thing you can read and confirm, four
 * identical guards are a thing that is correct until someone adds a fifth
 * method.
 */
class ModerationController extends Controller
{
    use RespondsWithApi;

    public function __construct(
        private readonly ListingRepository $listings,
        private readonly ModerationService $moderation,
    ) {}

    /**
     * Open reports, oldest first.
     *
     * ponytail: offset paging again, for the same reason as browse — a queue
     * that is ever long enough for this to matter is a queue that needs assignment
     * and claiming, not a better cursor.
     */
    public function index(Request $request): JsonResponse
    {
        $limit = max(1, min($request->integer('limit', 50), 100));
        $offset = max(0, $request->integer('cursor'));
        $reports = $this->listings->openReports($limit, $offset);

        $hasMore = $reports->count() === $limit;

        return $this->page(
            $reports->map(fn (ListingReport $report): array => [
                'id' => $report->id,
                'kind' => $report->kind,
                'reason' => $report->reason,
                'detail' => $report->detail,
                'created_at' => $report->created_at?->toIso8601String(),
                'reporter' => $report->reporter?->only(['id', 'name']),
                'listing' => new ListingResource($report->listing),
            ])->all(),
            $hasMore ? $offset + $limit : null,
            $hasMore,
        );
    }

    /**
     * Down. Distribution stops on the next request; nobody's collection moves.
     */
    public function takedown(Request $request, Listing $listing): JsonResponse
    {
        $validated = $request->validate([
            'reason' => ['required', 'string', 'max:2000'],
        ]);

        return $this->ok(new ListingResource(
            $this->moderation->takedown($request->user(), $listing, $validated['reason']),
        ));
    }

    /** Approve a first-time publisher, or reinstate after a counter-notice. */
    public function approve(Request $request, Listing $listing): JsonResponse
    {
        $validated = $request->validate([
            'note' => ['nullable', 'string', 'max:2000'],
        ]);

        return $this->ok(new ListingResource(
            $this->moderation->approve($request->user(), $listing, $validated['note'] ?? null),
        ));
    }

    /** Nothing wrong with the deck: close the report, leave the listing alone. */
    public function dismiss(Request $request, ListingReport $report): JsonResponse
    {
        $validated = $request->validate([
            'note' => ['nullable', 'string', 'max:2000'],
        ]);

        $report = $this->moderation->dismiss($request->user(), $report, $validated['note'] ?? null);

        return $this->ok(['id' => $report->id, 'status' => $report->status]);
    }
}
