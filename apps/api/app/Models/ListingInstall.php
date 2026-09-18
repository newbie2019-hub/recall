<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A record that somebody cloned a listing, and at which version.
 *
 * `deck_id` names a deck in the *cloner's* collection. Nothing here grants the
 * publisher any reach into it: a clone is a copy, so upstream can offer an
 * update and can never apply one.
 */
#[Fillable(['id', 'listing_id', 'user_id', 'deck_id', 'version'])]
class ListingInstall extends Model
{
    use HasUuids;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return ['version' => 'integer'];
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
