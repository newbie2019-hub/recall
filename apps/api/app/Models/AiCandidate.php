<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A suggested card. Not a note, and deliberately not one until a person says so.
 */
#[Fillable([
    'id', 'ai_job_id', 'note_type', 'fields', 'tags', 'tier', 'dimension',
    'grade_reason', 'source_excerpt', 'content_hash', 'status',
])]
class AiCandidate extends Model
{
    use HasUuids;

    public const STATUS_PENDING = 'pending';

    public const STATUS_ACCEPTED = 'accepted';

    public const STATUS_REJECTED = 'rejected';

    protected function casts(): array
    {
        return [
            'fields' => 'array',
            'tags' => 'array',
            'tier' => 'integer',
        ];
    }

    public function job(): BelongsTo
    {
        return $this->belongsTo(AiJob::class, 'ai_job_id');
    }
}
