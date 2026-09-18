<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Contracts\Repositories\ListingRepository;
use App\Models\Listing;
use App\Models\ListingReport;
use App\Models\User;
use Illuminate\Support\Collection;

final class EloquentListingRepository implements ListingRepository
{
    /**
     * ponytail: `LIKE '%term%'` over three columns, which cannot use an index and
     * will scan the table. That is the right trade while the catalogue is small —
     * MySQL `FULLTEXT` on (title, description, tags) is the upgrade, and it is a
     * migration plus a `whereFullText()`, not a search engine. Note that the test
     * suite runs on SQLite, where a FULLTEXT index does not exist, so moving to
     * one means the browse test needs a MySQL connection.
     *
     * @return Collection<int, Listing>
     */
    public function browse(?string $term, ?string $tag, int $limit, int $offset): Collection
    {
        return Listing::query()
            ->browsable()
            // Without the columns named, `latestOfMany` selects `payload` too
            // and a page of twenty tiles carries twenty whole decks. Qualified,
            // because `latestOfMany` joins the table to itself and a bare
            // `listing_id` is then ambiguous.
            ->with(['user:id,name', 'latestVersionRow' => fn ($q) => $q->select([
                'listing_versions.id',
                'listing_versions.listing_id',
                'listing_versions.version',
                'listing_versions.semver',
                'listing_versions.note_count',
                'listing_versions.size_bytes',
            ])])
            ->when($term !== null && $term !== '', function ($query) use ($term): void {
                $query->where(function ($group) use ($term): void {
                    foreach (['title', 'description', 'tags'] as $column) {
                        $group->orWhereLike($column, '%'.$this->escapeLike($term).'%');
                    }
                });
            })
            // Tags are space-separated in one column, so a bare LIKE on "anatomy"
            // would also match "neuroanatomy". Matching each position the whole
            // word can occupy keeps it a word, without a driver-specific concat.
            ->when($tag !== null && $tag !== '', function ($query) use ($tag): void {
                $escaped = $this->escapeLike($tag);
                $query->where(function ($group) use ($escaped): void {
                    foreach ([$escaped, $escaped.' %', '% '.$escaped, '% '.$escaped.' %'] as $pattern) {
                        $group->orWhereLike('tags', $pattern);
                    }
                });
            })
            ->orderByDesc('install_count')
            ->orderByDesc('published_at')
            ->offset($offset)
            ->limit($limit)
            ->get();
    }

    public function findDistributable(string $id): ?Listing
    {
        return Listing::query()->distributable()->with('user:id,name')->find($id);
    }

    /**
     * @return Collection<int, Listing>
     */
    public function forPublisher(User $publisher): Collection
    {
        return Listing::query()
            ->where('user_id', $publisher->id)
            ->orderByDesc('updated_at')
            ->get();
    }

    /**
     * @return Collection<int, ListingReport>
     */
    public function openReports(int $limit, int $offset): Collection
    {
        return ListingReport::query()
            ->where('status', ListingReport::STATUS_OPEN)
            ->with(['listing:id,user_id,title,tags,visibility,status,install_count,latest_version,published_at', 'reporter:id,name'])
            ->orderBy('created_at')
            ->offset($offset)
            ->limit($limit)
            ->get();
    }

    public function hasApprovedListing(User $publisher): bool
    {
        return Listing::query()
            ->where('user_id', $publisher->id)
            ->whereNotNull('moderated_at')
            ->where('status', Listing::STATUS_PUBLISHED)
            ->exists();
    }

    /** A term containing `%` or `_` must match those characters, not act as one. */
    private function escapeLike(string $term): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\%', '\_'], $term);
    }
}
