<?php

declare(strict_types=1);

namespace Tests\Feature\Marketplace;

use App\Models\Listing;
use App\Models\User;

class RatingTest extends MarketplaceTestCase
{
    public function test_only_somebody_who_cloned_the_deck_may_rate_it(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));
        $stranger = $this->account();

        $this->actingAsToken($this->tokenFor($stranger))
            ->putJson(route('marketplace.listings.rate', $listing), ['stars' => 5])
            ->assertForbidden();

        $this->assertSame(0, $listing->refresh()->rating_count);

        // The same person, after cloning it, may.
        $this->actingAsToken($this->tokenFor($stranger))
            ->postJson(route('marketplace.listings.install', $listing), [
                'deck_id' => $this->deckWithNotes($stranger, 'Clone')->id,
                'version' => 1,
            ])
            ->assertCreated();

        $this->actingAsToken($this->tokenFor($stranger))
            ->putJson(route('marketplace.listings.rate', $listing), ['stars' => 4])
            ->assertOk()
            ->assertJsonPath('data.rating_count', 1)
            ->assertJsonPath('data.your_rating', 4);
    }

    public function test_rating_again_replaces_rather_than_adds(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));
        $cloner = $this->cloner($listing);

        $this->actingAsToken($this->tokenFor($cloner))
            ->putJson(route('marketplace.listings.rate', $listing), ['stars' => 2])
            ->assertOk();

        $this->actingAsToken($this->tokenFor($cloner))
            ->putJson(route('marketplace.listings.rate', $listing), ['stars' => 5])
            ->assertOk()
            ->assertJsonPath('data.rating_count', 1)
            ->assertJsonPath('data.rating_sum', 5);

        $this->assertDatabaseCount('listing_ratings', 1);

        // The average on the public listing follows the correction, and the
        // viewer is told what they themselves gave it.
        $this->actingAsToken($this->tokenFor($cloner))
            ->getJson(route('marketplace.listings.show', $listing))
            ->assertOk()
            ->assertJsonPath('data.rating_average', 5)
            ->assertJsonPath('your_rating', 5);
    }

    public function test_the_average_is_null_until_somebody_rates_and_strangers_see_no_rating_of_their_own(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->anonymous()->getJson(route('marketplace.listings.show', $listing))
            ->assertOk()
            // Not 0.0: "nobody has said" and "everybody said zero" are different
            // facts and only one of them is fair to print on a new deck.
            ->assertJsonPath('data.rating_average', null)
            ->assertJsonPath('data.rating_count', 0)
            ->assertJsonPath('your_rating', 0);
    }

    public function test_a_removed_deck_cannot_be_rated(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));
        $cloner = $this->cloner($listing);

        $this->actingAsToken($this->tokenFor($this->account(moderator: true)))
            ->postJson(route('moderation.listings.takedown', $listing), ['reason' => 'Textbook scans.'])
            ->assertOk();

        $this->actingAsToken($this->tokenFor($cloner))
            ->putJson(route('marketplace.listings.rate', $listing), ['stars' => 5])
            ->assertNotFound();
    }

    public function test_stars_outside_one_to_five_are_rejected(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));
        $cloner = $this->cloner($listing);

        foreach ([0, 6, -1] as $stars) {
            $this->actingAsToken($this->tokenFor($cloner))
                ->putJson(route('marketplace.listings.rate', $listing), ['stars' => $stars])
                ->assertStatus(422);
        }

        $this->assertSame(0, $listing->refresh()->rating_count);
    }

    /** An account that has cloned this listing and may therefore rate it. */
    private function cloner(Listing $listing): User
    {
        $cloner = $this->account();

        $this->actingAsToken($this->tokenFor($cloner))
            ->postJson(route('marketplace.listings.install', $listing), [
                'deck_id' => $this->deckWithNotes($cloner, 'Clone')->id,
                'version' => 1,
            ])
            ->assertCreated();

        return $cloner;
    }
}
