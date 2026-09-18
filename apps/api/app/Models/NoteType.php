<?php

namespace App\Models;

use App\Models\Concerns\SyncsToDevices;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable([
    'id', 'user_id', 'name', 'fields', 'templates', 'css', 'kind', 'ord_field',
    'sort_field', 'field_config', 'anki_extra', 'builtin', 'revision',
    'client_updated_at', 'deleted_at',
])]
class NoteType extends Model
{
    use SyncsToDevices;

    protected function casts(): array
    {
        return [
            'fields' => 'array',
            'templates' => 'array',
            'field_config' => 'array',
            'anki_extra' => 'array',
            'builtin' => 'boolean',
            'sort_field' => 'integer',
            'client_updated_at' => 'integer',
            'revision' => 'integer',
            'deleted_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
