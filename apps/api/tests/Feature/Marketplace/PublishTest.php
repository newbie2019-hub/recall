<?php

declare(strict_types=1);

namespace Tests\Feature\Marketplace;

use App\Models\Listing;
use App\Models\Note;
use App\Services\Marketplace\CloneGuid;
use Illuminate\Support\Str;

class PublishTest extends MarketplaceTestCase
{
    public function test_publishing_requires_a_verified_email_address(): void
    {
        $publisher = $this->account(verified: false);
        $deck = $this->deckWithNotes($publisher);

        $this->actingAsToken($this->tokenFor($publisher))
            ->postJson(route('marketplace.listings.store'), $this->publishBody($deck))
            ->assertForbidden();

        $this->assertDatabaseCount('listings', 0);
    }

    public function test_a_first_time_publisher_waits_for_a_human_before_distributing(): void
    {
        $publisher = $this->account();
        $deck = $this->deckWithNotes($publisher);

        $this->actingAsToken($this->tokenFor($publisher))
            ->postJson(route('marketplace.listings.store'), $this->publishBody($deck))
            ->assertCreated()
            ->assertJsonPath('data.status', Listing::STATUS_IN_REVIEW);

        $listing = Listing::query()->firstOrFail();

        $this->anonymous()->getJson(route('marketplace.listings.index'))->assertJsonCount(0, 'data');
        $this->anonymous()->getJson(route('marketplace.listings.version', [$listing, 1]))->assertNotFound();
    }

    public function test_an_already_approved_publisher_publishes_without_waiting(): void
    {
        $publisher = $this->account();
        $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $second = $this->deckWithNotes($publisher, 'Pharmacology');

        $this->actingAsToken($this->tokenFor($publisher))
            ->postJson(route('marketplace.listings.store'), $this->publishBody($second, ['title' => 'Beta blockers']))
            ->assertCreated()
            ->assertJsonPath('data.status', Listing::STATUS_PUBLISHED);
    }

    public function test_a_second_publish_cuts_a_new_version_and_leaves_the_first_downloadable(): void
    {
        $publisher = $this->account();
        $deck = $this->deckWithNotes($publisher);
        $listing = $this->publishedListing($publisher, $deck);

        $this->actingAsToken($this->tokenFor($publisher))
            ->postJson(route('marketplace.listings.store'), $this->publishBody($deck, [
                'changelog' => 'Fixed the azygos vein card.',
                'semver' => '1.1.0',
            ]))
            ->assertCreated()
            ->assertJsonPath('data.latest_version', 2);

        // What a client holding v1 needs: v2 exists, and v1 is still there to
        // diff against rather than a deck it has to download twice.
        $this->anonymous()->getJson(route('marketplace.listings.show', $listing))
            ->assertOk()
            ->assertJsonPath('data.latest_version', 2)
            ->assertJsonPath('data.versions.0.changelog', 'Fixed the azygos vein card.');

        $this->anonymous()->getJson(route('marketplace.listings.version', [$listing, 1]))->assertOk();
        $this->anonymous()->getJson(route('marketplace.listings.version', [$listing, 2]))->assertOk();

        $this->assertDatabaseCount('listing_versions', 2);
    }

    public function test_the_payload_publishes_source_guids_and_never_a_guid(): void
    {
        $publisher = $this->account();
        $deck = $this->deckWithNotes($publisher);
        $listing = $this->publishedListing($publisher, $deck);

        $payload = $this->anonymous()->getJson(route('marketplace.listings.version', [$listing, 1]))
            ->assertOk()
            ->json('data.payload');

        $upstream = Note::query()->where('deck_id', $deck->id)->orderBy('revision')->pluck('guid')->all();

        $this->assertCount(2, $payload['notes']);
        $this->assertSame($upstream, array_column($payload['notes'], 'source_guid'));
        // The name is the guard rail: a cloner that copies this into `notes.guid`
        // collides with the original the first time both land in one collection.
        $this->assertArrayNotHasKey('guid', $payload['notes'][0]);
        $this->assertCount(1, $payload['decks']);
        $this->assertNull($payload['decks'][0]['parent_id']);
    }

    public function test_a_cloned_guid_is_stable_per_deck_and_different_between_clones(): void
    {
        $first = (string) Str::uuid();
        $second = (string) Str::uuid();

        // Stable, so merging v2 onto v1 finds the note the cloner already has.
        $this->assertSame(
            CloneGuid::derive($first, 'aabbccddeeff0011'),
            CloneGuid::derive($first, 'aabbccddeeff0011'),
        );

        // Distinct, so two clones of one listing — or a clone of your own deck —
        // can sit in one collection without one overwriting the other.
        $this->assertNotSame(
            CloneGuid::derive($first, 'aabbccddeeff0011'),
            CloneGuid::derive($second, 'aabbccddeeff0011'),
        );

        $this->assertMatchesRegularExpression('/^[0-9a-f]{16}$/', CloneGuid::derive($first, 'aabbccddeeff0011'));
    }

    public function test_you_cannot_publish_a_deck_that_is_not_yours(): void
    {
        $stranger = $this->account();
        $deck = $this->deckWithNotes($this->account(), 'Someone elses deck');

        $this->actingAsToken($this->tokenFor($stranger))
            ->postJson(route('marketplace.listings.store'), $this->publishBody($deck))
            ->assertNotFound();

        $this->assertDatabaseCount('listings', 0);
    }

    public function test_a_publisher_can_stop_distributing_without_losing_the_versions(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->actingAsToken($this->tokenFor($publisher))
            ->deleteJson(route('marketplace.listings.destroy', $listing))
            ->assertOk()
            ->assertJsonPath('data.status', Listing::STATUS_DRAFT);

        $this->anonymous()->getJson(route('marketplace.listings.version', [$listing, 1]))->assertNotFound();
        $this->assertDatabaseCount('listing_versions', 1);
    }

    public function test_a_stranger_cannot_unpublish_someone_elses_listing(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->actingAsToken($this->tokenFor($this->account()))
            ->deleteJson(route('marketplace.listings.destroy', $listing))
            ->assertForbidden();

        $this->assertSame(Listing::STATUS_PUBLISHED, $listing->refresh()->status);
    }
}
