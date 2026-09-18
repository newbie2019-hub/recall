<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One published snapshot of a deck. Immutable by convention and by use: nothing
 * in this codebase updates a row here, because a cloner holding v3 has to be
 * able to diff against exactly the bytes they cloned.
 *
 * `payload` is deliberately *not* cast to an array: the checksum is taken over
 * the exact JSON string that is stored, and a cast that re-encodes on the way in
 * is how the stored bytes and the checksum drift apart.
 */
#[Fillable([
    'id', 'listing_id', 'version', 'semver', 'changelog', 'payload', 'checksum',
    'note_count', 'size_bytes', 'rights_attestation', 'attested_ip',
])]
class ListingVersion extends Model
{
    use HasUuids;

    /** What a publisher may assert about the deck they are publishing. */
    public const RIGHTS = ['own_work', 'permission', 'public_domain', 'open_license'];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'version' => 'integer',
            'note_count' => 'integer',
            'size_bytes' => 'integer',
        ];
    }

    public function listing(): BelongsTo
    {
        return $this->belongsTo(Listing::class);
    }
}
