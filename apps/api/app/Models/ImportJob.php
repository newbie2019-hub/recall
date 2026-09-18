<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * An `.apkg` upload on its way into an account.
 *
 * Not a syncable resource: the import's *result* syncs to every device as
 * notes, decks and reviews, but the job itself is a detail of the machine that
 * ran it and is only ever read by the client that started it.
 */
#[Fillable(['user_id', 'original_name', 'path', 'status', 'stage', 'done', 'total', 'report', 'error'])]
class ImportJob extends Model
{
    use HasUuids;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'done' => 'integer',
            'total' => 'integer',
            'report' => 'array',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
