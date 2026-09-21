<?php

namespace App\Models;

use App\Models\Concerns\SyncsToDevices;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * An uploaded file, named by the sha256 of its bytes.
 *
 * Named `MediaFile` rather than `Media` because `media` is already the plural
 * and Eloquent would look for a `medias` table.
 *
 * `HasUuids` because this model has **two** ways to be created and only one of
 * them can mint a key. `MediaStore` and the `.apkg` importer both hand over an
 * `id` explicitly; `SyncService` cannot, because a synced row is addressed by
 * `sha256` (see `SyncResource::key()`) and `id` is therefore not in
 * `writable()`. So the first device to announce a file it holds produced an
 * insert with no primary key and a 500 on every subsequent sync. A model that
 * names its own key cannot be created wrong by a caller that does not know it
 * needs one.
 */
#[Fillable(['id', 'user_id', 'sha256', 'mime', 'size', 'path', 'completed_at', 'revision'])]
class MediaFile extends Model
{
    use HasUuids, SyncsToDevices;

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
