<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Review;
use App\Models\User;
use App\Services\Scheduling\CardState;
use App\Services\Scheduling\Replay;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * Rebuilding a schedule from the log, server-side.
 *
 * The fold itself is pinned by `FsrsFixtureTest`; what is checked here is the
 * plumbing around it, where the mistakes are the kind that look like nothing:
 * reviews arriving out of order, two reviews sharing a millisecond, and cards
 * from one account leaking into another's replay.
 */
class ReplayTest extends TestCase
{
    use RefreshDatabase;

    private const T0 = 1_767_258_000_000; // 2026-01-01T09:00:00Z

    private const DAY = 86_400_000;

    public function test_it_rebuilds_a_card_from_its_reviews(): void
    {
        $user = User::factory()->create();
        $this->log($user, 'n:0', [[0, 3], [10 * 60_000, 3], [2 * self::DAY, 3]]);

        $state = app(Replay::class)->card(Review::query()->where('card_id', 'n:0')->get());

        $this->assertSame(CardState::REVIEW, $state->state);
        $this->assertSame(3, $state->reps);
        $this->assertSame(0, $state->lapses);
        $this->assertGreaterThan(0.0, $state->stability);
    }

    public function test_the_order_rows_come_back_in_does_not_change_the_answer(): void
    {
        // The log is append-only but rows arrive from several devices and are
        // stored in whatever order they synced. A fold that depended on that
        // would give two devices two different schedules for the same card.
        $user = User::factory()->create();
        $this->log($user, 'n:0', [[0, 3], [10 * 60_000, 1], [2 * self::DAY, 3], [9 * self::DAY, 2]]);

        $forwards = Review::query()->where('card_id', 'n:0')->orderBy('client_ts')->get();
        $backwards = Review::query()->where('card_id', 'n:0')->orderByDesc('client_ts')->get();

        $replay = app(Replay::class);
        $this->assertEquals($replay->card($forwards)->toArray(), $replay->card($backwards)->toArray());
    }

    public function test_two_reviews_in_the_same_millisecond_still_fold_deterministically(): void
    {
        // Rare and real: a double tap, or an import that flattened timestamps.
        // Whatever the answer is, it has to be the same answer every time.
        $user = User::factory()->create();
        $this->log($user, 'n:0', [[0, 3], [60_000, 3], [60_000, 1]]);

        $replay = app(Replay::class);
        $first = $replay->card(Review::query()->where('card_id', 'n:0')->orderBy('id')->get());
        $second = $replay->card(Review::query()->where('card_id', 'n:0')->orderByDesc('id')->get());

        $this->assertEquals($first->toArray(), $second->toArray());
    }

    public function test_a_lapse_is_counted_and_the_card_goes_back_to_relearning(): void
    {
        $user = User::factory()->create();
        $this->log($user, 'n:0', [[0, 3], [10 * 60_000, 3], [3 * self::DAY, 3], [20 * self::DAY, 1]]);

        $state = app(Replay::class)->card(Review::query()->where('card_id', 'n:0')->get());

        $this->assertSame(CardState::RELEARNING, $state->state);
        $this->assertSame(1, $state->lapses);
    }

    public function test_a_whole_collection_replays_card_by_card(): void
    {
        $user = User::factory()->create();
        $stranger = User::factory()->create();

        $this->log($user, 'n:0', [[0, 3], [10 * 60_000, 3]]);
        $this->log($user, 'n:1', [[0, 1], [60_000, 3]]);
        $this->log($stranger, 'someone:0', [[0, 3]]);

        $states = app(Replay::class)->collection($user);

        $this->assertSame(['n:0', 'n:1'], array_keys($states), 'one account only');
        $this->assertSame(2, $states['n:0']->reps);

        // Failing a card you have never learned is not a lapse — it never had
        // anything to lose. Lapses only count from the review state, which is
        // why a true-retention figure and a lapse count disagree on a new
        // card and are both right.
        $this->assertSame(0, $states['n:1']->lapses);
        $this->assertSame(2, $states['n:1']->reps);
    }

    public function test_the_retention_target_moves_the_due_date_and_not_the_memory(): void
    {
        // Which is what makes an account-wide default a safe approximation for
        // a dashboard: stability and difficulty are exact, only the due date is
        // an estimate.
        $user = User::factory()->create();
        $this->log($user, 'n:0', [[0, 3], [10 * 60_000, 3], [2 * self::DAY, 3]]);

        $reviews = Review::query()->where('card_id', 'n:0')->get();
        $replay = app(Replay::class);

        $low = $replay->card($reviews, 0.8);
        $high = $replay->card($reviews, 0.95);

        $this->assertSame($low->stability, $high->stability);
        $this->assertSame($low->difficulty, $high->difficulty);
        $this->assertGreaterThan($high->due, $low->due, 'a lower target buys a longer interval');
    }

    /**
     * @param  list<array{0: int, 1: int}>  $moves  offset from T0, rating
     */
    private function log(User $user, string $cardId, array $moves): void
    {
        foreach ($moves as $i => [$offset, $rating]) {
            Review::query()->create([
                'id' => (string) Str::uuid(),
                'user_id' => $user->id,
                'card_id' => $cardId,
                'client_ts' => self::T0 + $offset,
                'server_received_at' => self::T0 + $offset,
                'rating' => $rating,
                'duration_ms' => 3000,
                'revision' => $i + 1,
            ]);
        }
    }
}
