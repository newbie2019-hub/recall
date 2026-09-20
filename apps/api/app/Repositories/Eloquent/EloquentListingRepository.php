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
     * Browse, with the search term going through an index where there is one.
     *
     * Search *was* `LIKE '%term%'` over three columns, which cannot use an
     * index at all — a leading wildcard makes a B-tree useless — so every query
     * scanned the table. `FULLTEXT` on (title, description, tags) fixes that,
     * and it is a migration plus a `whereFullText()` rather than a search
     * engine.
     *
     * **There are two paths and there has to be.** The suite runs on SQLite,
     * which has no `FULLTEXT`, so assuming MySQL here would turn every browse
     * test red — the trap the old comment named and this is the answer to it.
     * MySQL gets the index; everything else keeps the scan, which is correct at
     * the sizes a SQLite deployment reaches anyway.
     *
     * ⚠️ **InnoDB does not update a FULLTEXT index until the inserting
     * transaction commits.** A listing created inside one is therefore not
     * matchable until it lands — harmless in production, where publishing
     * commits, and extremely confusing anywhere else. Verified by hand against
     * the development MySQL: the same row returns zero rows inside a
     * transaction and matches every term outside one. If this suite is ever
     * pointed at MySQL, `RefreshDatabase` wraps each test in a transaction and
     * every search assertion will return nothing — for this reason, not
     * because the query is wrong.
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
                if ($this->hasFullText()) {
                    // Boolean mode with a trailing `*` so "anat" still finds
                    // "anatomy" — a marketplace search box is a prefix search in
                    // the user's head, whatever the index calls it.
                    $query->whereFullText(
                        ['title', 'description', 'tags'],
                        self::booleanTerm($term),
                        ['mode' => 'boolean'],
                    );

                    return;
                }

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
     * Three columns and no relations: this answers "is there a newer version"
     * for every cloned deck in a collection at once, and loading a publisher or
     * a version payload to compare two integers would make the cheapest call in
     * the marketplace the most expensive one.
     *
     * @param  list<string>  $ids
     * @return Collection<int, Listing>
     */
    public function distributableByIds(array $ids): Collection
    {
        return Listing::query()
            ->distributable()
            ->whereIn('id', $ids)
            ->get(['id', 'title', 'latest_version']);
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
    /**
     * The queue, keyset-paged and honest about who is holding what.
     *
     * **Offset paging was wrong here for a reason that is not performance.** A
     * report arriving while somebody reads page two shifts every row down one,
     * so the next page silently re-shows a report they already passed and skips
     * one they never saw. In a queue whose whole job is "nothing is missed",
     * that is the failure mode.
     *
     * The cursor is `(created_at, id)`. The id breaks ties, because two reports
     * filed in the same second are ordinary and a cursor on the timestamp alone
     * either loses one or repeats it forever.
     *
     * @param  array{ts: string, id: string}|null  $after
     */
    public function openReports(int $limit, ?array $after = null): Collection
    {
        return ListingReport::query()
            ->where('status', ListingReport::STATUS_OPEN)
            ->with([
                'listing:id,user_id,title,tags,visibility,status,install_count,latest_version,published_at',
                'reporter:id,name',
                'claimant:id,name',
            ])
            ->when($after !== null, fn ($q) => $q->where(
                fn ($w) => $w->where('created_at', '>', $after['ts'])
                    ->orWhere(fn ($t) => $t->where('created_at', $after['ts'])->where('id', '>', $after['id'])),
            ))
            ->orderBy('created_at')
            ->orderBy('id')
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
    private function hasFullText(): bool
    {
        return in_array(Listing::query()->getConnection()->getDriverName(), ['mysql', 'mariadb'], true);
    }

    /**
     * A search box's words, as a boolean-mode query.
     *
     * Operator characters are stripped rather than escaped: `+`, `-`, `*`, `(`
     * and `"` all mean something in boolean mode, and a person typing
     * "anti-inflammatory" means the word, not "not inflammatory". Each word is
     * required and prefix-matched.
     */
    public static function booleanTerm(string $term): string
    {
        $words = preg_split('/\s+/u', trim(preg_replace('/[+\-><()~*:"@&|]/u', ' ', $term) ?? '')) ?: [];

        $clean = array_values(array_filter($words, fn (string $w): bool => mb_strlen($w) > 0));

        return implode(' ', array_map(fn (string $w): string => '+'.$w.'*', $clean));
    }

    private function escapeLike(string $term): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\%', '\_'], $term);
    }
}
