<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

/**
 * A deck offered to other people, in one of four states.
 *
 * The states are the moderation surface, not decoration: `draft` is the
 * publisher's, `in_review` is a first-time publisher waiting on a human,
 * `published` is the only state that distributes, and `removed` is a takedown
 * that stops distribution without touching a single cloned collection.
 *
 * The statuses are class constants rather than an enum because they are compared
 * against a `string` column in queries in three layers here; an enum would be
 * cast on the way out and unwrapped again on the way in for no gain.
 */
#[Fillable([
    'id', 'user_id', 'deck_id', 'title', 'description', 'tags', 'visibility',
    'status', 'latest_version', 'published_at',
])]
class Listing extends Model
{
    use HasUuids;

    public const STATUS_DRAFT = 'draft';

    public const STATUS_IN_REVIEW = 'in_review';

    public const STATUS_PUBLISHED = 'published';

    public const STATUS_REMOVED = 'removed';

    public const VISIBILITY_PUBLIC = 'public';

    public const VISIBILITY_UNLISTED = 'unlisted';

    /** @var list<string> */
    public const VISIBILITIES = [self::VISIBILITY_PUBLIC, self::VISIBILITY_UNLISTED];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'latest_version' => 'integer',
            'install_count' => 'integer',
            'open_report_count' => 'integer',
            'rating_count' => 'integer',
            'rating_sum' => 'integer',
            'published_at' => 'datetime',
            'moderated_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @return HasMany<ListingVersion, $this>
     */
    /**
     * The newest version alone, for the browse tiles.
     *
     * `HasOne` over `latestOfMany` rather than loading `versions`: a tile needs
     * a note count and a size, and eager-loading the whole relation would drag
     * every version's `payload` — megabytes per listing, times a page of
     * twenty — to print two numbers.
     */
    public function latestVersionRow(): HasOne
    {
        return $this->hasOne(ListingVersion::class)->latestOfMany('version');
    }

    public function versions(): HasMany
    {
        return $this->hasMany(ListingVersion::class)->orderByDesc('version');
    }

    /**
     * @return HasMany<ListingReport, $this>
     */
    public function reports(): HasMany
    {
        return $this->hasMany(ListingReport::class);
    }

    /**
     * @return HasMany<ListingInstall, $this>
     */
    public function installs(): HasMany
    {
        return $this->hasMany(ListingInstall::class);
    }

    /**
     * @return HasMany<ListingRating, $this>
     */
    public function ratings(): HasMany
    {
        return $this->hasMany(ListingRating::class);
    }

    /**
     * The decision history, newest first. Append-only — see the migration.
     *
     * @return HasMany<ListingModerationEvent, $this>
     */
    public function moderationEvents(): HasMany
    {
        return $this->hasMany(ListingModerationEvent::class)->orderByDesc('created_at');
    }

    /**
     * The average, to one decimal, or null when nobody has rated it.
     *
     * Null rather than zero on purpose: "0.0 ★" and "nobody has said" are
     * different facts, and only one of them is fair to print on a new deck.
     */
    public function ratingAverage(): ?float
    {
        return $this->rating_count > 0
            ? round($this->rating_sum / $this->rating_count, 1)
            : null;
    }

    /**
     * The one gate every download, preview and clone passes through.
     *
     * Written once as a scope so that a takedown is a single `status` write and
     * every distribution path stops together — a per-endpoint check is how one of
     * them keeps serving the deck after it has been removed.
     *
     * @param  Builder<self>  $query
     * @return Builder<self>
     */
    public function scopeDistributable(Builder $query): Builder
    {
        return $query->where('status', self::STATUS_PUBLISHED);
    }

    /**
     * Distributable *and* findable. Unlisted decks are reachable by link only.
     *
     * @param  Builder<self>  $query
     * @return Builder<self>
     */
    public function scopeBrowsable(Builder $query): Builder
    {
        return $query->distributable()->where('visibility', self::VISIBILITY_PUBLIC);
    }

    public function isDistributable(): bool
    {
        return $this->status === self::STATUS_PUBLISHED;
    }
}
