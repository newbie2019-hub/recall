<?php

declare(strict_types=1);

namespace App\Services\Ai;

use App\Models\AiJob;
use App\Models\AiUsage;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

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

    /**
     * Micro-dollars promised to work that has not been charged for yet.
     *
     * AI.md §3.4: one upload is eight generation calls plus three grading
     * calls, so the money is committed at dispatch and spent over the next few
     * minutes. Between those two moments the allowance looked untouched —
     * `canSpend` summed `ai_usage` and nothing else — which meant a queued job
     * and an interactive call could each be told the same dollar was theirs.
     *
     * Counted from the job's *status* rather than released by a completion
     * hook: a reservation that has to be explicitly returned is a reservation
     * that leaks the first time a worker dies mid-run, and the leak is
     * invisible because it looks exactly like normal spending.
     *
     * A running job's real rows are already in {@see spent()}, so its
     * reservation is reduced by what it has actually charged. Without that
     * subtraction a job would be counted twice for its whole run and the
     * allowance would sag in the middle of the thing it was reserved for.
     *
     * `$exceptJob` is how a job spends the money it reserved. Its own
     * reservation is not an obstacle to its own calls — AI.md §3.4 step 2 —
     * and without this a document whose estimate used the last of an allowance
     * would reserve itself into a deadlock and never make its first call.
     */
    public function reserved(User $user, ?string $exceptJob = null): int
    {
        $jobs = AiJob::query()
            ->where('user_id', $user->id)
            ->whereIn('status', [AiJob::STATUS_QUEUED, AiJob::STATUS_RUNNING])
            ->when($exceptJob !== null, fn ($q) => $q->whereKeyNot($exceptJob))
            ->pluck('reserved_micros', 'id');

        if ($jobs->isEmpty()) {
            return 0;
        }

        $charged = AiUsage::query()
            ->selectRaw('job_id, SUM(cost_micros) AS micros')
            ->whereIn('job_id', $jobs->keys())
            ->groupBy('job_id')
            ->pluck('micros', 'job_id');

        // A job that overran its estimate contributes nothing further: the
        // overrun is already real spend, and the estimate was only ever a
        // ceiling (AI.md §3.4).
        $outstanding = 0;
        foreach ($jobs as $id => $reserved) {
            $outstanding += max(0, (int) $reserved - (int) ($charged[$id] ?? 0));
        }

        return $outstanding;
    }

    public function remaining(User $user, ?string $exceptJob = null): int
    {
        return max(0, $this->limit($user) - $this->spent($user) - $this->reserved($user, $exceptJob));
    }

    /**
     * Whether a call costing roughly this much may go ahead.
     *
     * An estimate, checked *per call* rather than once per job: one upload is
     * eight generation calls plus three grading calls, and a check that passed
     * at the start has been irrelevant since the second one (AI.md §6.6).
     */
    public function canSpend(User $user, int $estimateMicros = 0, ?string $exceptJob = null): bool
    {
        return $this->remaining($user, $exceptJob) >= max(0, $estimateMicros);
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

        // The token columns are summed alongside the dollars because they are
        // the part of the bill that does not move when a price does: a rate
        // change reprices history, and "how much did I send" is the question
        // that still has the same answer afterwards.
        $rows = AiUsage::query()
            ->selectRaw(
                'feature, COUNT(*) AS calls, SUM(cost_micros) AS micros,'
                .' SUM(input_tokens) AS input_tokens, SUM(cache_write_tokens) AS cache_write_tokens,'
                .' SUM(cache_read_tokens) AS cache_read_tokens, SUM(output_tokens) AS output_tokens'
            )
            ->where('user_id', $user->id)
            ->where('created_at', '>=', $start)
            ->groupBy('feature')
            ->get();

        $spent = (int) $rows->sum('micros');
        $reserved = $this->reserved($user);
        $limit = $this->limit($user);

        return [
            'plan' => $user->ai_plan,
            'period_start' => $start->toIso8601String(),
            'period_end' => $start->copy()->addMonth()->toIso8601String(),
            'spent_micros' => $spent,
            'limit_micros' => $limit,
            // Shown rather than silently deducted: an allowance that reads
            // smaller than the sum of the calls below it is a number nobody
            // can check, and "a document you are still processing has claimed
            // this much" is a sentence with an answer.
            'reserved_micros' => $reserved,
            'remaining_micros' => max(0, $limit - $spent - $reserved),
            'tokens' => $this->tokens($rows),
            'by_feature' => $rows
                ->mapWithKeys(fn ($r) => [$r->feature => [
                    'calls' => (int) $r->calls,
                    'micros' => (int) $r->micros,
                    'tokens' => $this->tokens(collect([$r])),
                ]])
                ->all(),
            'consented' => $user->ai_consent_at !== null,
            'available' => Claude::configured(),
        ];
    }

    /**
     * Tokens, as Anthropic counts them.
     *
     * The two cache figures are kept apart from `input` rather than folded in,
     * because they are priced differently (1.25x to write, 0.10x to read) and
     * a single "input" number would make the dollars beside it unexplainable.
     *
     * @param  Collection<int, AiUsage>  $rows
     * @return array{input: int, cache_write: int, cache_read: int, output: int}
     */
    private function tokens($rows): array
    {
        return [
            'input' => (int) $rows->sum('input_tokens'),
            'cache_write' => (int) $rows->sum('cache_write_tokens'),
            'cache_read' => (int) $rows->sum('cache_read_tokens'),
            'output' => (int) $rows->sum('output_tokens'),
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
