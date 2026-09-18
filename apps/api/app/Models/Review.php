<?php

namespace App\Models;

use App\Models\Concerns\SyncsToDevices;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One answer. Append only — never updated, never deleted.
 */
#[Fillable([
    'id', 'user_id', 'card_id', 'client_ts', 'server_received_at', 'rating',
    'duration_ms', 'imported', 'revision',
])]
class Review extends Model
{
    use SyncsToDevices;

    /** There is no `updated_at`: a row that is never updated has nothing to put in it. */
    public const UPDATED_AT = null;

    protected function casts(): array
    {
        return [
            'client_ts' => 'integer',
            'server_received_at' => 'integer',
            'rating' => 'integer',
            'duration_ms' => 'integer',
            'imported' => 'boolean',
            'revision' => 'integer',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
