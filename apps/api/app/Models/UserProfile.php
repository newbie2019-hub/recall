<?php

declare(strict_types=1);

namespace App\Models;

use App\Services\Onboarding\OnboardingService;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One account's answers to the welcome wizard.
 *
 * Written only through {@see OnboardingService}, which owns the one rule worth
 * protecting: the answers are validated against a list this codebase keeps, so
 * a column that is later grouped by cannot fill up with free text somebody's
 * client invented.
 */
#[Fillable([
    'id', 'user_id', 'role', 'country', 'subject', 'subject_other', 'level',
    'goals', 'daily_minutes', 'exam_date', 'heard_from', 'heard_from_other',
    'referral_code', 'completed_at',
])]
class UserProfile extends Model
{
    use HasUuids;

    protected function casts(): array
    {
        return [
            'goals' => 'array',
            'daily_minutes' => 'integer',
            'exam_date' => 'date',
            'completed_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
