<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Services\Scheduling\CardState;
use App\Services\Scheduling\Fsrs;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * The server's FSRS against the client's, step for step.
 *
 * Two implementations of a scheduler are right exactly when they agree, so
 * there is no judgement in this file: every expected number comes from
 * `ts-fsrs` by way of `packages/core/scripts/fsrs-fixture.ts`, and the cases
 * cover each transition the state machine has — the learning steps, Easy
 * skipping them, a lapse into relearning, same-day repeats, a card months
 * overdue, and the retention target moving mid-history.
 *
 * Regenerate the fixture when ts-fsrs is upgraded (`pnpm -F @recall/core
 * fixture`). A diff there is the upgrade's real changelog, and this suite going
 * red afterwards is the PHP port asking to be brought along rather than a
 * mystery to debug.
 */
class FsrsFixtureTest extends TestCase
{
    /**
     * @return iterable<string, array{0: array<string, mixed>}>
     */
    public static function cases(): iterable
    {
        $path = __DIR__.'/../Fixtures/fsrs.json';
        $fixture = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);

        foreach ($fixture['cases'] as $case) {
            yield $case['name'] => [$case];
        }
    }

    /**
     * @param  array<string, mixed>  $case
     */
    #[DataProvider('cases')]
    public function test_it_reproduces_the_client_exactly(array $case): void
    {
        $fsrs = new Fsrs;
        $card = CardState::fresh(0);

        foreach ($case['steps'] as $i => $step) {
            $card = $fsrs->next($card, $step['rating'], $step['at'], $step['retention']);
            $want = $step['after'];
            $where = "{$case['name']}, step ".($i + 1)." (rating {$step['rating']})";

            $this->assertSame($want['state'], $card->state, "state: {$where}");
            $this->assertSame($want['reps'], $card->reps, "reps: {$where}");
            $this->assertSame($want['lapses'], $card->lapses, "lapses: {$where}");
            $this->assertSame($want['learning_steps'], $card->learningSteps, "learning steps: {$where}");
            $this->assertSame($want['last_review'], $card->lastReview, "last review: {$where}");

            // Floats compared to 1e-9: these are the numbers scheduling is
            // built on, and "close enough" is how two implementations drift
            // apart over a year of reviews.
            $this->assertEqualsWithDelta($want['stability'], $card->stability, 1e-9, "stability: {$where}");
            $this->assertEqualsWithDelta($want['difficulty'], $card->difficulty, 1e-9, "difficulty: {$where}");

            // The due date is an integer instant. It has to match exactly —
            // one millisecond out is a card in the wrong day's queue.
            $this->assertSame($want['due'], $card->due, "due: {$where}");
        }
    }
}
