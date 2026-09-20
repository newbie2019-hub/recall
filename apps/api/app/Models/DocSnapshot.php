<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A deck's Y.Doc, compacted by a client into one blob.
 *
 * One row per deck: a second snapshot replaces the first, because an older
 * compaction of the same document is superseded rather than historical. What is
 * historical lives in `doc_updates` until it is pruned.
 */
#[Fillable(['deck_id', 'payload', 'up_to_seq', 'actor_id'])]
class DocSnapshot extends Model
{
    protected $primaryKey = 'deck_id';

    public $incrementing = false;

    protected $keyType = 'string';

    protected function casts(): array
    {
        return ['up_to_seq' => 'integer'];
    }

    public function deck(): BelongsTo
    {
        return $this->belongsTo(Deck::class);
    }
}
