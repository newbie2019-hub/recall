<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One entry in a listing's moderation history. Append-only by convention and by
 * use: nothing in the application updates or deletes one.
 */
#[Fillable(['id', 'listing_id', 'moderator_id', 'action', 'resulting_status', 'reason'])]
class ListingModerationEvent extends Model
{
    use HasUuids;

    public const ACTION_PUBLISH = 'publish';

    public const ACTION_APPROVE = 'approve';

    public const ACTION_UNLIST = 'unlist';

    public const ACTION_TAKEDOWN = 'takedown';

    public const ACTION_DISMISS = 'dismiss';

    public const ACTION_COUNTER_NOTICE = 'counter_notice';

    public function listing(): BelongsTo
    {
        return $this->belongsTo(Listing::class);
    }

    public function moderator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'moderator_id');
    }
}
