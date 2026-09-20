<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\Note;
use App\Models\User;
use App\Services\Scheduling\Replay;
use Illuminate\Console\Command;

/**
 * Rebuild an account's schedules from its review log and report what it found.
 *
 * Read-only, on purpose and permanently: the client schedules, the server
 * derives. What this is *for* is the class of bug that has bitten this codebase
 * twice — a log and a schedule that quietly stop agreeing. `changeNoteType`
 * left review rows pointing at a card id that no longer existed, and nothing
 * noticed until somebody reasoned about it. A fold over the log that reports
 * cards with no history, histories with no card and impossible states is the
 * cheapest standing check against the next one.
 *
 *   php artisan schedules:replay --email=someone@example.com
 */
class ReplaySchedules extends Command
{
    protected $signature = 'schedules:replay
        {--email= : One account, rather than all of them}
        {--retention=0.9 : The target to derive due dates against}';

    protected $description = 'Rebuild scheduling from the review log and report anything that does not add up';

    public function handle(Replay $replay): int
    {
        $accounts = User::query()
            ->when($this->option('email'), fn ($q, $email) => $q->where('email', $email))
            ->get();

        if ($accounts->isEmpty()) {
            $this->warn('No accounts matched.');

            return self::SUCCESS;
        }

        $retention = (float) $this->option('retention');
        $problems = 0;

        foreach ($accounts as $user) {
            $states = $replay->collection($user, $retention);

            if ($states === []) {
                continue;
            }

            // A card id is `<note id>:<ord>`. A review pointing at a note that
            // is gone is the shape of the `changeNoteType` bug, and the shape
            // of a sync that half-applied.
            $noteIds = array_values(array_unique(array_map(
                fn (string $cardId): string => (string) substr($cardId, 0, (int) strrpos($cardId, ':')),
                array_keys($states),
            )));

            $known = Note::query()
                ->where('user_id', $user->id)
                ->whereIn('id', $noteIds)
                ->pluck('id')
                ->flip();
            $orphans = array_values(array_filter(
                array_keys($states),
                fn (string $cardId): bool => ! $known->has(substr($cardId, 0, (int) strrpos($cardId, ':'))),
            ));

            $this->line(sprintf(
                '%-34s %6d cards  %6d reviews%s',
                $user->email,
                count($states),
                array_sum(array_map(fn ($s): int => $s->reps, $states)),
                $orphans === [] ? '' : '  ⚠ '.count($orphans).' with no note',
            ));

            if ($orphans !== []) {
                $problems += count($orphans);
                foreach (array_slice($orphans, 0, 5) as $cardId) {
                    $this->warn("    history for a card that does not exist: {$cardId}");
                }
            }
        }

        if ($problems > 0) {
            $this->error("{$problems} card histories point at notes that are not there.");

            return self::FAILURE;
        }

        $this->info('Every history belongs to a note that exists.');

        return self::SUCCESS;
    }
}
