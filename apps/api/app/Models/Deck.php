<?php

namespace App\Models;

use App\Models\Concerns\SyncsToDevices;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable([
    'id', 'user_id', 'parent_id', 'name', 'retention_target', 'new_per_day',
    'visibility', 'revision', 'client_updated_at', 'deleted_at',
])]
class Deck extends Model
{
    use SyncsToDevices;

    protected function casts(): array
    {
        return [
            'retention_target' => 'float',
            'new_per_day' => 'integer',
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
