<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Contracts\Repositories\ListingRepository;
use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Resources\ListingResource;
use App\Models\Listing;
use App\Models\ListingModerationEvent;
use App\Models\ListingReport;
use App\Services\Marketplace\ModerationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The queue, the decisions that come out of it, and the trail they leave.
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
    /**
     * The queue, keyset-paged.
     *
     * The cursor is `<iso timestamp>|<id>` rather than an offset: a report
     * arriving while somebody reads page two would shift every row down one,
     * so the next page re-shows a report they already passed and skips one they
     * never saw. In a queue whose entire job is "nothing is missed", that is
     * the failure that matters.
     */
    public function index(Request $request): JsonResponse
    {
        $limit = max(1, min($request->integer('limit', 50), 100));
        $after = $this->cursor($request->query('cursor'));
        $reports = $this->listings->openReports($limit, $after);

        $hasMore = $reports->count() === $limit;
        $last = $reports->last();

        return $this->page(
            $reports->map(fn (ListingReport $report): array => [
                'id' => $report->id,
                'kind' => $report->kind,
                'reason' => $report->reason,
                'detail' => $report->detail,
                'created_at' => $report->created_at?->toIso8601String(),
                'reporter' => $report->reporter?->only(['id', 'name']),
                'listing' => new ListingResource($report->listing),
                // Who else is looking at this right now, so two moderators do
                // not write the same decision twice.
                'claimed_by' => $this->moderation->heldByAnother($request->user(), $report)
                    ? $report->claimant?->only(['id', 'name'])
                    : null,
                'mine' => $report->claimed_by === $request->user()->id,
            ])->all(),
            // Formatted the way the column stores it, not as ISO-8601: the
            // comparison happens in SQL, and an offset-bearing string does not
            // compare against a `DATETIME` the way it reads like it should.
            $hasMore && $last ? $last->created_at?->utc()->format('Y-m-d H:i:s').'|'.$last->id : null,
            $hasMore,
        );
    }

    /** Take a report. Refused when somebody else already holds it. */
    public function claim(Request $request, ListingReport $report): JsonResponse
    {
        if (! $this->moderation->claim($request->user(), $report)) {
            throw new ApiException(
                ApiErrorCode::Forbidden,
                'Another moderator is working on that one.',
            );
        }

        return $this->ok(['claimed' => true]);
    }

    /** Put it back for somebody else. */
    public function release(Request $request, ListingReport $report): JsonResponse
    {
        $this->moderation->release($request->user(), $report);

        return $this->ok(['claimed' => false]);
    }

    /**
     * @return array{ts: string, id: string}|null
     */
    private function cursor(mixed $raw): ?array
    {
        if (! is_string($raw) || ! str_contains($raw, '|')) {
            return null;
        }

        [$ts, $id] = explode('|', $raw, 2);

        return $ts === '' || $id === '' ? null : ['ts' => $ts, 'id' => $id];
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

    /**
     * Out of the catalogue, still reachable by link. The middle setting.
     */
    public function unlist(Request $request, Listing $listing): JsonResponse
    {
        $validated = $request->validate([
            'reason' => ['required', 'string', 'max:2000'],
        ]);

        return $this->ok(new ListingResource(
            $this->moderation->unlist($request->user(), $listing, $validated['reason']),
        ));
    }

    /**
     * Everything that has ever been decided about one listing, newest first.
     *
     * Moderator-only: the trail names the moderator who acted and quotes the
     * reasons, and a reason written for the record is not written for the
     * publisher's deck page.
     */
    public function history(Listing $listing): JsonResponse
    {
        return $this->ok(
            $listing->moderationEvents()->with('moderator:id,name')->limit(100)->get()
                ->map(fn (ListingModerationEvent $event): array => [
                    'id' => $event->id,
                    'action' => $event->action,
                    'resulting_status' => $event->resulting_status,
                    'reason' => $event->reason,
                    'moderator' => $event->moderator?->only(['id', 'name']),
                    'created_at' => $event->created_at?->toIso8601String(),
                ])->all(),
        );
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
