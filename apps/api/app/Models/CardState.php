<?php

namespace App\Models;

use App\Models\Concerns\SyncsToDevices;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * What a person decided about a card. Not its schedule — see the migration.
 */
#[Fillable([
    'id', 'user_id', 'note_id', 'ord', 'suspended', 'buried_until', 'flag',
    'deck_id', 'revision', 'client_updated_at', 'deleted_at',
])]
class CardState extends Model
{
    use SyncsToDevices;

    protected function casts(): array
    {
        return [
            'ord' => 'integer',
            'suspended' => 'boolean',
            'buried_until' => 'integer',
            'flag' => 'integer',
            'client_updated_at' => 'integer',
            'revision' => 'integer',
            'deleted_at' => 'datetime',
        ];
    }

    public function note(): BelongsTo
    {
        return $this->belongsTo(Note::class);
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
