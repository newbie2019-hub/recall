<?php

namespace App\Models;

use App\Models\Concerns\SyncsToDevices;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * An uploaded file, named by the sha256 of its bytes.
 *
 * Named `MediaFile` rather than `Media` because `media` is already the plural
 * and Eloquent would look for a `medias` table.
 */
#[Fillable(['id', 'user_id', 'sha256', 'mime', 'size', 'path', 'completed_at', 'revision'])]
class MediaFile extends Model
{
    use SyncsToDevices;

    protected $table = 'media';

    protected function casts(): array
    {
        return [
            'size' => 'integer',
            'revision' => 'integer',
            'completed_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
