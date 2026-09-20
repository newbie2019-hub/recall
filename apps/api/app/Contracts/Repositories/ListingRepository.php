<?php

declare(strict_types=1);

namespace App\Contracts\Repositories;

use App\Models\Listing;
use App\Models\ListingReport;
use App\Models\User;
use Illuminate\Support\Collection;

/**
 * Reads for the marketplace: browse, the publisher's own shelf, and the queue.
 *
 * Behind an interface for the same reason the sync reads are — the browse query
 * is the one thing here a cache or a read replica would plausibly serve, and the
 * controllers should not learn about it when it does.
 */
interface ListingRepository
{
    /**
     * Public, published listings matching a term and/or a tag.
     *
     * @return Collection<int, Listing>
     */
    public function browse(?string $term, ?string $tag, int $limit, int $offset): Collection;

    /** A listing anyone may still download — unlisted included, removed excluded. */
    public function findDistributable(string $id): ?Listing;

    /**
     * The same rule in bulk, for the update check a collection makes on load.
     *
     * @param  list<string>  $ids
     * @return Collection<int, Listing>
     */
    public function distributableByIds(array $ids): Collection;

    /**
     * Everything this publisher has, in every state.
     *
     * @return Collection<int, Listing>
     */
    public function forPublisher(User $publisher): Collection;

    /**
     * The moderation queue, oldest first: a report that has waited longest is the
     * one most likely to be the one that matters.
     *
     * @return Collection<int, ListingReport>
     */
    /** @param array{ts: string, id: string}|null $after keyset cursor, not an offset */
    public function openReports(int $limit, ?array $after = null): Collection;

    /** Has a human ever approved anything this account published? */
    public function hasApprovedListing(User $publisher): bool;
}
