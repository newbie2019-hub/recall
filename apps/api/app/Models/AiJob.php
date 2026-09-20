<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One generation run. Shaped like `ImportJob`, because it is the same problem:
 * hand over a file, wait, get a report.
 */
#[Fillable([
    'id', 'user_id', 'kind', 'source_name', 'source_path', 'status', 'stage',
    'done', 'total', 'estimated_micros', 'reserved_micros', 'error',
])]
class AiJob extends Model
{
    use HasUuids;

    public const STATUS_QUEUED = 'queued';

    public const STATUS_RUNNING = 'running';

    public const STATUS_DONE = 'done';

    public const STATUS_FAILED = 'failed';

    /** Stopped early — out of allowance, or the source ran out of usable text. */
    public const STATUS_PARTIAL = 'partial';

    protected function casts(): array
    {
        return [
            'done' => 'integer',
            'total' => 'integer',
            'estimated_micros' => 'integer',
            'reserved_micros' => 'integer',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function candidates(): HasMany
    {
        return $this->hasMany(AiCandidate::class);
    }

    public function finished(): bool
    {
        return in_array($this->status, [self::STATUS_DONE, self::STATUS_FAILED, self::STATUS_PARTIAL], true);
    }
}
