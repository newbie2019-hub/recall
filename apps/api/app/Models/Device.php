<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A signed-in device: its token and its sync cursor, in one row.
 */
#[Fillable(['user_id', 'name', 'token_id', 'cursor', 'platform', 'last_seen_at'])]
class Device extends Model
{
    use HasUuids;

    protected function casts(): array
    {
        return [
            'cursor' => 'integer',
            'last_seen_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * The Sanctum token this device currently authenticates with.
     *
     * Null once the token expires or is revoked, which is a state the device row
     * is designed to survive: the cursor is still correct, so signing in again
     * resumes instead of re-pulling the collection.
     */
    public function token(): BelongsTo
    {
        return $this->belongsTo(PersonalAccessToken::class, 'token_id');
    }
}
