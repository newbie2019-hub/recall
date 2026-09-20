<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One Yjs update, stored and never inspected.
 *
 * `$timestamps` is half off because the table has `created_at` and no
 * `updated_at`: a row here is written once and is never edited, which is the
 * same append-only discipline `reviews` keeps for the same reason — it is the
 * record of what happened, not a cache of what is true now.
 */
#[Fillable(['deck_id', 'actor_id', 'payload'])]
class DocUpdate extends Model
{
    protected $primaryKey = 'seq';

    public const UPDATED_AT = null;

    protected function casts(): array
    {
        return ['seq' => 'integer', 'created_at' => 'datetime'];
    }

    public function deck(): BelongsTo
    {
        return $this->belongsTo(Deck::class);
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_id');
    }
}
