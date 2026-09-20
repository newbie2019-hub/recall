<?php

declare(strict_types=1);

namespace App\Models;

use App\Services\Marketplace\RatingService;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One person's stars on one listing.
 *
 * Writing goes through {@see RatingService} and never
 * directly: the row and the two denormalised counters on `listings` have to move
 * together, and a model that can be saved on its own is how they stop matching.
 */
#[Fillable(['id', 'listing_id', 'user_id', 'stars'])]
class ListingRating extends Model
{
    use HasUuids;

    public const MIN = 1;

    public const MAX = 5;

    protected function casts(): array
    {
        return ['stars' => 'integer'];
    }

    public function listing(): BelongsTo
    {
        return $this->belongsTo(Listing::class);
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
