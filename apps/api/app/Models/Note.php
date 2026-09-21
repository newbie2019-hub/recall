<?php

namespace App\Models;

use App\Models\Concerns\SyncsToDevices;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable([
    'id', 'user_id', 'guid', 'note_type_id', 'deck_id', 'fields', 'tags',
    'fma_id', 'checksum', 'revision', 'client_updated_at', 'client_created_at',
    'deleted_at',
])]
class Note extends Model
{
    use SyncsToDevices;

    protected function casts(): array
    {
        return [
            'fields' => 'array',
            'checksum' => 'integer',
            'client_updated_at' => 'integer',
            'client_created_at' => 'integer',
            'revision' => 'integer',
            'deleted_at' => 'datetime',
        ];
    }

    public function deck(): BelongsTo
    {
        return $this->belongsTo(Deck::class);
    }

    public function noteType(): BelongsTo
    {
        return $this->belongsTo(NoteType::class);
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
