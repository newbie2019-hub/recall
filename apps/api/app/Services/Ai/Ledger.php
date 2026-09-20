<?php

declare(strict_types=1);

namespace App\Services\Ai;

use App\Models\AiUsage;
use App\Models\User;
use Illuminate\Support\Carbon;

/**
 * What has been spent, and what is left.
 *
 * Every number here is derived from `ai_usage` by query (AI.md §3.2). There is
 * no cached total and no `credits_remaining` column, because a counter that can
 * disagree with the log is a support ticket with no answer — the same reason
 * `cards` is a rebuildable cache of `reviews` rather than the truth.
 */
final readonly class Ledger
{
    /**
     * Micro-dollars spent in this user's current period.
     *
     * The period start is **stored**, never computed from `now()`. A window
     * derived from the wall clock on each request grants a second allowance
     * across one DST boundary and denies one across the other (AI.md §3.5) —
     * the same bug shape as Phase 9's compaction watermark, arriving late and
     * looking like something else.
     */
    public function spent(User $user): int
    {
        return (int) AiUsage::query()
            ->where('user_id', $user->id)
            ->where('created_at', '>=', $this->periodStart($user))
            ->sum('cost_micros');
    }

    public function limit(User $user): int
    {
        return (int) config("ai.plans.{$user->ai_plan}.limit_micros", 0);
    }

    public function remaining(User $user): int
    {
        return max(0, $this->limit($user) - $this->spent($user));
    }

    /**
     * Whether a call costing roughly this much may go ahead.
     *
     * An estimate, checked *per call* rather than once per job: one upload is
     * eight generation calls plus three grading calls, and a check that passed
     * at the start has been irrelevant since the second one (AI.md §6.6).
     */
    public function canSpend(User $user, int $estimateMicros = 0): bool
    {
        return $this->remaining($user) >= max(0, $estimateMicros);
    }

    /**
     * The whole picture, for `GET /ai/usage` and the Settings panel.
     *
     * The per-feature split exists so the number is explainable. "You have used
     * 60% of your month" invites one question, and this is its answer.
     *
     * @return array<string, mixed>
     */
    public function summary(User $user): array
    {
        $start = $this->periodStart($user);

        $rows = AiUsage::query()
            ->selectRaw('feature, COUNT(*) AS calls, SUM(cost_micros) AS micros')
            ->where('user_id', $user->id)
            ->where('created_at', '>=', $start)
            ->groupBy('feature')
            ->get();

        $spent = (int) $rows->sum('micros');
        $limit = $this->limit($user);

        return [
            'plan' => $user->ai_plan,
            'period_start' => $start->toIso8601String(),
            'period_end' => $start->copy()->addMonth()->toIso8601String(),
            'spent_micros' => $spent,
            'limit_micros' => $limit,
            'remaining_micros' => max(0, $limit - $spent),
            'by_feature' => $rows
                ->mapWithKeys(fn ($r) => [$r->feature => [
                    'calls' => (int) $r->calls,
                    'micros' => (int) $r->micros,
                ]])
                ->all(),
            'consented' => $user->ai_consent_at !== null,
            'available' => Claude::configured(),
        ];
    }

    /**
     * The start of the period, stored on first use.
     *
     * Written once rather than back-filled for every account on migration: an
     * account that never touches AI does not need a period, and the row is
     * cheaper to create when it is first needed than to maintain for everyone.
     */
    public function periodStart(User $user): Carbon
    {
        if ($user->ai_period_start === null) {
            $user->forceFill(['ai_period_start' => now()->startOfDay()])->save();
        }

        return Carbon::instance($user->ai_period_start);
    }
}
