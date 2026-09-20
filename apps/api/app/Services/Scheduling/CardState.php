<?php

declare(strict_types=1);

namespace App\Services\Scheduling;

/**
 * A card's scheduling state, mid-replay.
 *
 * A value object rather than a model on purpose: **there is no table for this.**
 * `card_states` carries what a person decided — suspended, flagged, buried —
 * and never a schedule, because a schedule is a cache of the review log. This
 * is the cache, rebuilt on demand and thrown away.
 *
 * Immutable, so a fold over a log cannot accidentally share state between two
 * cards; `with()` is how each step produces the next.
 */
final readonly class CardState
{
    public const NEW = 'new';

    public const LEARNING = 'learning';

    public const REVIEW = 'review';

    public const RELEARNING = 'relearning';

    public function __construct(
        public int $due = 0,
        public float $stability = 0.0,
        public float $difficulty = 0.0,
        public string $state = self::NEW,
        public int $learningSteps = 0,
        public int $reps = 0,
        public int $lapses = 0,
        public ?int $lastReview = null,
    ) {}

    public static function fresh(int $createdAt): self
    {
        return new self(due: $createdAt);
    }

    public function with(
        ?int $due = null,
        ?float $stability = null,
        ?float $difficulty = null,
        ?string $state = null,
        ?int $learningSteps = null,
        ?int $reps = null,
        ?int $lapses = null,
        ?int $lastReview = null,
    ): self {
        return new self(
            due: $due ?? $this->due,
            stability: $stability ?? $this->stability,
            difficulty: $difficulty ?? $this->difficulty,
            state: $state ?? $this->state,
            learningSteps: $learningSteps ?? $this->learningSteps,
            reps: $reps ?? $this->reps,
            lapses: $lapses ?? $this->lapses,
            lastReview: $lastReview ?? $this->lastReview,
        );
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'due' => $this->due,
            'stability' => $this->stability,
            'difficulty' => $this->difficulty,
            'state' => $this->state,
            'learning_steps' => $this->learningSteps,
            'reps' => $this->reps,
            'lapses' => $this->lapses,
            'last_review' => $this->lastReview,
        ];
    }
}
