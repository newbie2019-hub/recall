<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A report against a listing, or a publisher's counter-notice about a takedown.
 */
#[Fillable([
    'id', 'listing_id', 'reporter_id', 'kind', 'reason', 'detail', 'status',
    'resolved_by', 'resolved_at', 'resolution_note',
])]
class ListingReport extends Model
{
    use HasUuids;

    public const KIND_REPORT = 'report';

    public const KIND_COUNTER_NOTICE = 'counter_notice';

    public const STATUS_OPEN = 'open';

    public const STATUS_UPHELD = 'upheld';

    public const STATUS_DISMISSED = 'dismissed';

    /**
     * Both intake paths land in the same column. `copyright` covers a Copyright
     * Act 1968 notice and a DMCA-shaped one alike — the difference is in what the
     * notice says, not in what the reporter clicks (PHASES §8).
     *
     * @var list<string>
     */
    public const REASONS = ['copyright', 'inappropriate', 'spam', 'malware', 'other'];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return ['resolved_at' => 'datetime'];
    }

    public function listing(): BelongsTo
    {
        return $this->belongsTo(Listing::class);
    }

    public function reporter(): BelongsTo
    {
        return $this->belongsTo(User::class, 'reporter_id');
    }
}
