<?php

declare(strict_types=1);

namespace App\Services\Scheduling;

use App\Models\Review;
use App\Models\User;
use Illuminate\Support\Collection;

/**
 * Rebuild scheduling from the review log, server-side.
 *
 * The client does this on the device and always has; this is the same fold for
 * the two things a phone cannot do — reporting across a whole account without
 * shipping the collection, and fitting FSRS parameters to a full history.
 *
 * **It writes nothing.** There is no scheduling column on the server to write
 * to (see `Fsrs`), and that absence is what keeps offline-first honest: a
 * device that has been off the network for a fortnight is not holding a stale
 * copy of a truth the server owns. It is holding the truth, and the server is
 * holding a derivation.
 *
 * The retention target is a per-deck setting the server does not sync, so it is
 * passed in. Getting it wrong changes intervals and *only* intervals — the
 * memory state is independent of it — so an account-wide default gives correct
 * stability and difficulty with approximate due dates, which is the right trade
 * for a dashboard and the wrong one for anything that schedules. Nothing here
 * schedules.
 */
final readonly class Replay
{
    public function __construct(private Fsrs $fsrs) {}

    /**
     * One card's state, from its own reviews.
     *
     * @param  Collection<int, Review>|list<Review>  $reviews  any order
     */
    public function card(iterable $reviews, float $retention = 0.9, ?int $createdAt = null): CardState
    {
        $ordered = collect($reviews)->sortBy([
            fn (Review $a, Review $b): int => $a->client_ts <=> $b->client_ts,
            // A deterministic tiebreak, because two reviews can share a
            // millisecond and a fold whose order depends on the database's mood
            // is a fold that disagrees with itself.
            fn (Review $a, Review $b): int => strcmp($a->id, $b->id),
        ])->values();

        $state = CardState::fresh($createdAt ?? (int) ($ordered->first()?->client_ts ?? 0));

        foreach ($ordered as $review) {
            $state = $this->fsrs->next($state, (int) $review->rating, (int) $review->client_ts, $retention);
        }

        return $state;
    }

    /**
     * Every card this account has a history for.
     *
     * Grouped in memory rather than per-card queried: an account's whole log is
     * one indexed read, and a query per card over ten thousand cards is the
     * shape of slow that only shows up in production.
     *
     * @return array<string, CardState> keyed by card id
     */
    public function collection(User $user, float $retention = 0.9): array
    {
        $out = [];

        Review::query()
            ->where('user_id', $user->id)
            ->orderBy('card_id')
            ->orderBy('client_ts')
            ->orderBy('id')
            ->get(['id', 'card_id', 'client_ts', 'rating'])
            ->groupBy('card_id')
            ->each(function (Collection $reviews, string $cardId) use (&$out, $retention): void {
                $out[$cardId] = $this->card($reviews, $retention);
            });

        return $out;
    }
}
