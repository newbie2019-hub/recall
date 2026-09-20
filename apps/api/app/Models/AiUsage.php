<?php

declare(strict_types=1);

namespace App\Models;

use App\Services\Ai\Claude;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One call to Anthropic.
 *
 * Append-only: nothing updates or deletes a row here, and the quota is a `SUM`
 * over them rather than a counter anyone can drift. Written by {@see Claude}
 * and by nothing else — a feature that writes its own row is a feature that
 * will one day forget to.
 */
#[Fillable([
    'id', 'user_id', 'feature', 'job_id', 'model', 'input_tokens',
    'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'cost_micros',
    'price_version', 'status', 'stop_reason', 'request_id', 'latency_ms',
])]
class AiUsage extends Model
{
    use HasUuids;

    protected $table = 'ai_usage';

    public const UPDATED_AT = null;

    protected function casts(): array
    {
        return [
            'input_tokens' => 'integer',
            'cache_write_tokens' => 'integer',
            'cache_read_tokens' => 'integer',
            'output_tokens' => 'integer',
            'cost_micros' => 'integer',
            'latency_ms' => 'integer',
            'created_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
