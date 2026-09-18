<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Contracts\Repositories\ListingRepository;
use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\PublishListingRequest;
use App\Http\Requests\Api\V1\ReportListingRequest;
use App\Http\Resources\ListingResource;
use App\Http\Resources\ListingVersionResource;
use App\Models\Listing;
use App\Policies\ListingPolicy;
use App\Services\Marketplace\ModerationService;
use App\Services\Marketplace\PublishService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The marketplace as everybody except a moderator sees it: browse, preview,
 * download a version, publish, clone, report.
 *
 * Browsing and downloading are unauthenticated on purpose — a shared deck link
 * has to open for someone who does not have an account yet, or the link is not
 * shareable. Everything that *writes* is authenticated, and publishing is gated
 * on a verified email address by {@see ListingPolicy::publish()}.
 */
class ListingController extends Controller
{
    use RespondsWithApi;

    /** How many notes a preview shows before somebody has to clone the deck. */
    private const PREVIEW_NOTES = 5;

    public function __construct(
        private readonly ListingRepository $listings,
        private readonly PublishService $publish,
        private readonly ModerationService $moderation,
    ) {}

    /**
     * Browse and search.
     *
     * ponytail: `cursor` is an offset, not a keyset cursor, so a listing
     * published mid-scroll can shift a row across a page boundary. The
     * catalogue is small enough that this is invisible, and the fix is a keyset
     * on (install_count, id) once it is not.
     */
    public function index(Request $request): JsonResponse
    {
        $limit = max(1, min($request->integer('limit', 20), 50));
        $offset = max(0, $request->integer('cursor'));

        $listings = $this->listings->browse(
            $request->string('q')->trim()->value() ?: null,
            $request->string('tag')->trim()->value() ?: null,
            $limit,
            $offset,
        );

        $hasMore = $listings->count() === $limit;

        return $this->page(
            ListingResource::collection($listings),
            $hasMore ? $offset + $limit : null,
            $hasMore,
        );
    }

    /**
     * One listing, its version history, and enough notes to judge it by.
     *
     * The version list is what makes "you have v3, v4 is out" answerable on the
     * client: it holds `source_listing_id` and `source_version` already, so it
     * compares them against `latest_version` and offers the changelog in
     * between.
     */
    public function show(Request $request, Listing $listing): JsonResponse
    {
        $viewer = $request->user();

        // Not 403: whether a removed deck ever existed is not something a
        // stranger gets to learn from the status code.
        if (! $listing->isDistributable() && ! ($viewer !== null && $viewer->can('view', $listing))) {
            throw new ApiException(ApiErrorCode::NotFound, 'No such deck.');
        }

        $listing->load(['user:id,name', 'versions']);

        // The preview rides beside `data`, not inside the resource: `additional()`
        // is only applied when a resource is the response root, and this one is
        // nested in the standard envelope.
        return $this->ok(new ListingResource($listing), ['preview' => $this->preview($listing)]);
    }

    /**
     * The download: one immutable version, whole.
     *
     * Gated on `distributable`, which is the single switch a takedown flips — the
     * preview, the listing page and this endpoint stop together, and nothing that
     * has already been cloned is touched.
     */
    public function version(Listing $listing, int $version): JsonResponse
    {
        if (! $listing->isDistributable()) {
            throw new ApiException(ApiErrorCode::NotFound, 'That deck is no longer available.');
        }

        $row = $listing->versions()->where('version', $version)->first();

        if ($row === null) {
            throw new ApiException(ApiErrorCode::NotFound, 'No such version.');
        }

        return $this->ok(ListingVersionResource::withPayload($row));
    }

    /** The publisher's own shelf, in every state including removed. */
    public function mine(Request $request): JsonResponse
    {
        return $this->ok(ListingResource::collection($this->listings->forPublisher($request->user())));
    }

    public function store(PublishListingRequest $request): JsonResponse
    {
        $listing = $this->publish->publish($request->user(), $request->listing(), $request->ip());

        return $this->created(new ListingResource($listing->load('versions')));
    }

    /** The publisher stops distributing. Versions and clones both survive it. */
    public function destroy(Request $request, Listing $listing): JsonResponse
    {
        $this->denyUnless($request->user()->can('update', $listing));

        return $this->ok(new ListingResource($this->publish->unpublish($listing)));
    }

    /**
     * Record that a deck in this account came from this listing.
     *
     * The clone itself is the client's own write, synced up as the cloner's rows.
     * This endpoint only remembers where it came from, so an update can be
     * offered later and the publisher can see a number.
     */
    public function install(Request $request, Listing $listing): JsonResponse
    {
        $validated = $request->validate([
            'deck_id' => ['required', 'uuid'],
            'version' => ['required', 'integer', 'min:1'],
        ]);

        $install = $this->publish->recordInstall(
            $request->user(),
            $listing,
            $validated['deck_id'],
            (int) $validated['version'],
        );

        return $this->created(['deck_id' => $install->deck_id, 'version' => $install->version]);
    }

    /** Report a listing, or — as its publisher — counter-notice a takedown. */
    public function report(ReportListingRequest $request, Listing $listing): JsonResponse
    {
        $report = $this->moderation->report(
            $request->user(),
            $listing,
            $request->kind(),
            $request->string('reason')->toString(),
            $request->input('detail'),
        );

        return $this->created(['id' => $report->id, 'status' => $report->status]);
    }

    /**
     * A few notes from the latest version, so nobody clones blind.
     *
     * ponytail: decodes the whole version payload to take five notes off the
     * front. Free at today's sizes, wasteful at a 20,000-note deck's — cut a
     * `preview` column at publish time when that stops being theoretical.
     *
     * @return list<array<string, mixed>>
     */
    private function preview(Listing $listing): array
    {
        $latest = $listing->versions->first();

        if ($latest === null) {
            return ['notes' => [], 'note_types' => []];
        }

        /** @var array{notes?: list<array<string, mixed>>, note_types?: list<array<string, mixed>>} $payload */
        $payload = json_decode($latest->payload, true, 512, JSON_THROW_ON_ERROR);

        // The note types travel with the sample notes, because a card cannot be
        // rendered without its templates. Without them the listing page has to
        // download the whole version payload — megabytes — to draw three sample
        // cards on a page anyone can open. A deck's type list is small next to
        // its notes, so this is the cheap half.
        return [
            'notes' => array_slice($payload['notes'] ?? [], 0, self::PREVIEW_NOTES),
            'note_types' => $payload['note_types'] ?? [],
        ];
    }

    private function denyUnless(bool $allowed): void
    {
        if (! $allowed) {
            throw new ApiException(ApiErrorCode::Forbidden, 'That is not your deck.');
        }
    }
}
