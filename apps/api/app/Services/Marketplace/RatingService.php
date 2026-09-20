<?php

declare(strict_types=1);

namespace App\Services\Marketplace;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Models\Listing;
use App\Models\ListingInstall;
use App\Models\ListingRating;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Stars, and the one rule that makes them worth printing.
 *
 * **Only someone who cloned the deck may rate it.** Anything else is a number
 * about a listing's description, and the question a cloner is actually asking is
 * whether the cards were worth studying. It is also the cheapest anti-brigading
 * measure there is: a downvote costs a clone, which costs an account.
 *
 * The aggregate lives on `listings` as `rating_sum` / `rating_count` and is
 * moved in the same transaction as the row, by delta rather than by recount — a
 * recount would read every rating on a popular deck to add one.
 */
final readonly class RatingService
{
    /**
     * @return array{rating_count: int, rating_sum: int, your_rating: int}
     */
    public function rate(User $user, Listing $listing, int $stars): array
    {
        if ($stars < ListingRating::MIN || $stars > ListingRating::MAX) {
            throw new ApiException(ApiErrorCode::ValidationFailed, 'A rating is one to five stars.');
        }

        if (! $listing->isDistributable()) {
            throw new ApiException(ApiErrorCode::NotFound, 'That deck is no longer available.');
        }

        $held = ListingInstall::query()
            ->where('listing_id', $listing->id)
            ->where('user_id', $user->id)
            ->exists();

        if (! $held) {
            throw new ApiException(
                ApiErrorCode::Forbidden,
                'Add this deck to your collection before rating it.',
            );
        }

        return DB::transaction(function () use ($user, $listing, $stars): array {
            $rating = ListingRating::query()
                ->where('listing_id', $listing->id)
                ->where('user_id', $user->id)
                ->lockForUpdate()
                ->first();

            $previous = $rating?->stars ?? 0;

            if ($rating === null) {
                ListingRating::query()->create([
                    'listing_id' => $listing->id,
                    'user_id' => $user->id,
                    'stars' => $stars,
                ]);
            } else {
                $rating->update(['stars' => $stars]);
            }

            // Two atomic increments rather than a read-modify-write: two people
            // rating the same deck in the same second is the ordinary case, and
            // `$listing->rating_sum + $stars` is the version that loses one.
            $listing->increment('rating_sum', $stars - $previous);
            if ($previous === 0) {
                $listing->increment('rating_count');
            }

            $listing->refresh();

            return [
                'rating_count' => (int) $listing->rating_count,
                'rating_sum' => (int) $listing->rating_sum,
                'your_rating' => $stars,
            ];
        });
    }

    /** What this person gave it, if anything. Zero means "has not rated". */
    public function ratingBy(?User $user, Listing $listing): int
    {
        if ($user === null) {
            return 0;
        }

        return (int) ListingRating::query()
            ->where('listing_id', $listing->id)
            ->where('user_id', $user->id)
            ->value('stars');
    }
}
