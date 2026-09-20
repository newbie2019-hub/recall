<?php

declare(strict_types=1);

namespace App\Services\Scheduling;

/**
 * FSRS-6, as the client runs it.
 *
 * **This scheduler never decides anything.** The client is the only thing in
 * the product that schedules a card, and it has to stay that way: the
 * collection works offline for weeks, computing its own queue from its own log,
 * and a server that shipped a different `due` down would be changing somebody's
 * queue underneath them — "a count is a promise" (README rule 4) broken from
 * the outside, on a device that never asked.
 *
 * The guarantee is structural rather than a promise in this docblock: **there
 * is nowhere to write it.** `card_states` deliberately carries only what a
 * person decided — suspended, flagged, buried, deck override — and no
 * scheduling at all, because scheduling is a cache of `reviews`. So this
 * derives what the client would compute, for the two things a phone cannot do:
 * account-wide dashboards without shipping the collection, and fitting FSRS
 * parameters to a whole history.
 *
 * Which makes correctness a *matching* problem rather than a judgement one.
 * This is right exactly when it agrees with `ts-fsrs` step for step, and that
 * is pinned by `tests/Fixtures/fsrs.json`, generated from the client's own
 * scheduler. Four things in here were wrong on the first pass and the fixture
 * caught every one:
 *
 * - mean reversion targets the **unclamped** `D0(4)` (about −4.77), not the
 *   clamped 1.0 — a drift of ~0.006 per review, invisible by eye;
 * - every formula rounds to **8 decimal places at its own step**, and the
 *   rounded value is what the next step reads;
 * - `elapsed_days` is a difference of **UTC calendar dates**, not of
 *   milliseconds, so two reviews 23 hours apart are one day or none depending
 *   on which side of midnight they fall;
 * - a review card's intervals are forced into **strict order** across the four
 *   buttons, so Good can be a day longer than its own stability implies.
 *
 * Fuzz is off here as it is there: replay has to be exact, and a jittered
 * interval is not reproducible.
 */
final class Fsrs
{
    /** FSRS-6 defaults, matching `generatorParameters()` in ts-fsrs. */
    public const W = [
        0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
        1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
        1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
    ];

    /** Minutes. `["1m", "10m"]` in the client's parameters. */
    public const LEARNING_STEPS = [1.0, 10.0];

    /** Minutes. `["10m"]`. */
    public const RELEARNING_STEPS = [10.0];

    public const MAX_INTERVAL_DAYS = 36500;

    private const S_MIN = 0.001;

    private const MS_PER_DAY = 86_400_000;

    private const MS_PER_MINUTE = 60_000;

    /** A day's worth of minutes. Past this, a step is scheduled in days. */
    private const DAY_MINUTES = 1440;

    /**
     * Apply one rating and return the next state. Pure; `$rating` is 1–4.
     */
    public function next(CardState $card, int $rating, int $at, float $retention): CardState
    {
        $elapsed = $this->elapsedDays($card->lastReview, $at, $card->state);

        $base = $card->with(reps: $card->reps + 1, lastReview: $at);

        if ($card->state === CardState::REVIEW) {
            return $this->fromReview($card, $base, $rating, $at, $elapsed, $retention);
        }

        // New, learning and relearning all take the steps. The state a card
        // lands in is the one it came from, except a new card, which starts
        // learning.
        $memory = $this->memory($card, $elapsed, $rating);
        $to = $card->state === CardState::NEW ? CardState::LEARNING : $card->state;

        return $this->applySteps(
            $base->with(stability: $memory['stability'], difficulty: $memory['difficulty']),
            $card,
            $rating,
            $at,
            $elapsed,
            $to,
            $retention,
        );
    }

    /** Probability of recall after `$elapsedDays` at this stability. */
    public function retrievability(float $stability, float $elapsedDays): float
    {
        if ($stability <= 0) {
            return 0.0;
        }

        [$decay, $factor] = $this->decayFactor();

        // Rounded here too. `ts-fsrs` rounds the curve's output, and this value
        // feeds straight into the stability formulas — an unrounded R diverges
        // in the sixth decimal of the stability that comes out of it.
        return $this->round8((1 + $factor * max(0.0, $elapsedDays) / $stability) ** $decay);
    }

    /** Whole days until recall reaches `$retention`, clamped and rounded. */
    public function interval(float $stability, float $retention): int
    {
        return (int) min(
            self::MAX_INTERVAL_DAYS,
            max(1, round($stability * $this->intervalModifier($retention))),
        );
    }

    // ── transitions ───────────────────────────────────────────────────────

    /**
     * A card in review, which is the only branch that sees all four buttons.
     *
     * The intervals are computed together and forced into strict order — Hard
     * at most Good, Good at least Hard plus a day, Easy at least Good plus a
     * day. That is why a Good answer can be scheduled a day further out than
     * its own stability alone would put it, and it is not something a
     * per-rating implementation can reproduce by looking at one rating.
     */
    private function fromReview(CardState $card, CardState $base, int $rating, int $at, int $elapsed, float $retention): CardState
    {
        $recall = $this->retrievability($card->stability, $elapsed);

        if ($rating === 1) {
            $memory = $this->memory($card, $elapsed, 1, $recall);

            return $this->applySteps(
                $base->with(stability: $memory['stability'], difficulty: $memory['difficulty'], lapses: $card->lapses + 1),
                $card,
                1,
                $at,
                $elapsed,
                CardState::RELEARNING,
                $retention,
            );
        }

        $hard = $this->memory($card, $elapsed, 2, $recall);
        $good = $this->memory($card, $elapsed, 3, $recall);

        $hardDays = min($this->interval($hard['stability'], $retention), $this->interval($good['stability'], $retention));
        $goodDays = max($this->interval($good['stability'], $retention), $hardDays + 1);

        $days = match ($rating) {
            2 => $hardDays,
            3 => $goodDays,
            default => max($this->interval($this->memory($card, $elapsed, 4, $recall)['stability'], $retention), $goodDays + 1),
        };

        $memory = $rating === 2 ? $hard : ($rating === 3 ? $good : $this->memory($card, $elapsed, 4, $recall));

        return $base->with(
            stability: $memory['stability'],
            difficulty: $memory['difficulty'],
            state: CardState::REVIEW,
            learningSteps: 0,
            due: $at + $days * self::MS_PER_DAY,
        );
    }

    /**
     * The learning steps, exactly as ts-fsrs's `BasicLearningStepsStrategy`.
     *
     * The shape worth noticing: **Hard schedules the mean of the current step
     * and the next**, six minutes on a 1m/10m ladder — not a repeat of the
     * current step, which is the intuitive guess and is wrong. And Good with no
     * next step, Easy always, and any rating past the end of the ladder all
     * fall through to a real interval.
     */
    private function applySteps(CardState $next, CardState $card, int $rating, int $at, int $elapsed, string $to, float $retention): CardState
    {
        $steps = $to === CardState::RELEARNING || $card->state === CardState::REVIEW
            ? self::RELEARNING_STEPS
            : self::LEARNING_STEPS;

        [$minutes, $step] = $this->stepFor($steps, $card, $rating);

        if ($minutes > 0 && $minutes < self::DAY_MINUTES) {
            return $next->with(
                state: $to,
                learningSteps: $step,
                due: $at + (int) round($minutes) * self::MS_PER_MINUTE,
            );
        }

        // Out of the ladder: a real interval, rounded plainly. The ordering
        // constraint in `fromReview` does not apply here, which is why
        // graduating gives two days where the next same-day review gives three.
        return $next->with(
            state: CardState::REVIEW,
            learningSteps: 0,
            due: $at + $this->interval($next->stability, $retention) * self::MS_PER_DAY,
        );
    }

    /**
     * @param  list<float>  $steps
     * @return array{0: float, 1: int} minutes, and the step to land on
     */
    private function stepFor(array $steps, CardState $card, int $rating): array
    {
        $current = max(0, $card->learningSteps);

        if ($steps === [] || $current >= count($steps)) {
            return [0.0, 0];
        }

        // A card already in review that was failed restarts the relearning
        // ladder at its first step.
        if ($card->state === CardState::REVIEW) {
            return $rating === 1 ? [$steps[$current] ?? $steps[0], 0] : [0.0, 0];
        }

        return match ($rating) {
            1 => [$steps[0], 0],
            2 => [
                count($steps) === 1
                    ? round($steps[0] * 1.5)
                    : round(($steps[0] + $steps[1]) / 2),
                $current,
            ],
            3 => isset($steps[$current + 1]) ? [round($steps[$current + 1]), $current + 1] : [0.0, 0],
            // Easy is never in the ladder: it graduates.
            default => [0.0, 0],
        };
    }

    // ── memory state ──────────────────────────────────────────────────────

    /**
     * Stability and difficulty after one rating.
     *
     * Mirrors `FSRSAlgorithm.next_state`, including the order the branches are
     * tested in: a same-day answer takes the short-term formula whatever the
     * rating, so a lapse on the same day is *not* the forgetting curve.
     *
     * @return array{stability: float, difficulty: float}
     */
    private function memory(CardState $card, int $elapsed, int $rating, ?float $recall = null): array
    {
        if ($card->difficulty === 0.0 && $card->stability === 0.0) {
            return [
                'stability' => $this->initialStability($rating),
                'difficulty' => $this->clamp($this->initialDifficulty($rating), 1.0, 10.0),
            ];
        }

        $recall ??= $this->retrievability($card->stability, $elapsed);

        if ($elapsed === 0) {
            $stability = $this->shortTermStability($card->stability, $rating);
        } elseif ($rating === 1) {
            $afterFail = $this->forgetStability($card->difficulty, $card->stability, $recall);
            // A lapse may not leave a card more stable than a same-day repeat
            // would have — the clamp is against `afterFail`, not a floor.
            $floor = $card->stability / exp(self::W[17] * self::W[18]);
            $stability = $this->clamp($this->round8($floor), self::S_MIN, $afterFail);
        } else {
            $stability = $this->recallStability($card->difficulty, $card->stability, $recall, $rating);
        }

        return ['stability' => $stability, 'difficulty' => $this->nextDifficulty($card->difficulty, $rating)];
    }

    private function initialStability(int $rating): float
    {
        // 0.1, not `S_MIN` — a different floor, and one that matters for Again
        // on a brand-new card.
        return max(self::W[$rating - 1], 0.1);
    }

    /** Unclamped and rounded. The clamping happens at each use. */
    private function initialDifficulty(int $rating): float
    {
        return $this->round8(self::W[4] - exp(($rating - 1) * self::W[5]) + 1);
    }

    private function nextDifficulty(float $difficulty, int $rating): float
    {
        $delta = -self::W[6] * ($rating - 3);
        $damped = $difficulty + $this->round8($delta * (10 - $difficulty) / 9);

        // Reverting toward the *unclamped* `D0(4)`. See the class docblock.
        $reverted = $this->round8(self::W[7] * $this->initialDifficulty(4) + (1 - self::W[7]) * $damped);

        return $this->clamp($reverted, 1.0, 10.0);
    }

    private function recallStability(float $difficulty, float $stability, float $recall, int $rating): float
    {
        $hardPenalty = $rating === 2 ? self::W[15] : 1.0;
        $easyBonus = $rating === 4 ? self::W[16] : 1.0;

        $grown = $stability * (1 + exp(self::W[8])
            * (11 - $difficulty)
            * $stability ** (-self::W[9])
            * (exp((1 - $recall) * self::W[10]) - 1)
            * $hardPenalty
            * $easyBonus);

        return $this->round8($this->clamp($grown, self::S_MIN, (float) self::MAX_INTERVAL_DAYS));
    }

    private function forgetStability(float $difficulty, float $stability, float $recall): float
    {
        $value = self::W[11]
            * $difficulty ** (-self::W[12])
            * (($stability + 1) ** self::W[13] - 1)
            * exp((1 - $recall) * self::W[14]);

        return $this->round8($this->clamp($value, self::S_MIN, (float) self::MAX_INTERVAL_DAYS));
    }

    private function shortTermStability(float $stability, int $rating): float
    {
        $sinc = $stability ** (-self::W[19]) * exp(self::W[17] * ($rating - 3 + self::W[18]));

        // Hard counts as a pass here: anything but Again is floored at 1, so a
        // same-day Hard cannot reduce stability.
        if ($rating >= 2) {
            $sinc = max($sinc, 1.0);
        }

        return $this->round8($this->clamp($stability * $sinc, self::S_MIN, (float) self::MAX_INTERVAL_DAYS));
    }

    // ── arithmetic ────────────────────────────────────────────────────────

    /**
     * Whole **UTC calendar days** between two instants.
     *
     * Not `(b - a) / 86400000`. ts-fsrs compares calendar dates, so two reviews
     * twenty-three hours apart are one day if they straddle UTC midnight and
     * none if they do not — and `elapsed === 0` is what selects the short-term
     * stability formula, so this decides which curve a review gets.
     */
    private function elapsedDays(?int $lastReview, int $at, string $state): int
    {
        if ($lastReview === null || $state === CardState::NEW) {
            return 0;
        }

        $from = (int) (floor($lastReview / self::MS_PER_DAY));
        $to = (int) (floor($at / self::MS_PER_DAY));

        return max(0, $to - $from);
    }

    /** @return array{0: float, 1: float} decay and factor */
    private function decayFactor(): array
    {
        $decay = -self::W[20];

        // The factor is rounded before anything uses it, which matters twice
        // over: it divides into every interval and multiplies into every
        // retrievability.
        return [$decay, $this->round8(exp((1 / $decay) * log(0.9)) - 1)];
    }

    private function intervalModifier(float $retention): float
    {
        [$decay, $factor] = $this->decayFactor();

        return $this->round8(($retention ** (1 / $decay) - 1) / $factor);
    }

    private function round8(float $value): float
    {
        return round($value, 8);
    }

    private function clamp(float $value, float $min, float $max): float
    {
        return min($max, max($min, $value));
    }
}
