<?php

declare(strict_types=1);

namespace Tests\Feature\Marketplace;

use App\Models\Listing;

class BrowseTest extends MarketplaceTestCase
{
    public function test_browse_shows_only_published_public_decks(): void
    {
        $publisher = $this->account();
        $published = $this->publishedListing($publisher, $this->deckWithNotes($publisher, 'Anatomy'));

        // In review: published by the same account, but before approval.
        $pending = $this->deckWithNotes($publisher, 'Pharmacology');
        Listing::query()->create([
            'user_id' => $publisher->id,
            'deck_id' => $pending->id,
            'title' => 'Beta blockers',
            'status' => Listing::STATUS_IN_REVIEW,
            'visibility' => Listing::VISIBILITY_PUBLIC,
        ]);

        $response = $this->anonymous()->getJson(route('marketplace.listings.index'))->assertOk();

        $this->assertCount(1, $response->json('data'));
        $this->assertSame($published->id, $response->json('data.0.id'));
        // A stranger is not told what state anyone's listing is in.
        $this->assertArrayNotHasKey('status', $response->json('data.0'));
    }

    public function test_an_unlisted_deck_opens_by_link_but_never_by_browse(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing(
            $publisher,
            $this->deckWithNotes($publisher),
            ['visibility' => Listing::VISIBILITY_UNLISTED],
        );

        $this->anonymous()->getJson(route('marketplace.listings.index'))->assertJsonCount(0, 'data');
        $this->anonymous()->getJson(route('marketplace.listings.show', $listing))->assertOk();
        $this->anonymous()->getJson(route('marketplace.listings.version', [$listing, 1]))->assertOk();
    }

    public function test_search_matches_title_description_and_whole_tags(): void
    {
        $publisher = $this->account();
        $anatomy = $this->publishedListing($publisher, $this->deckWithNotes($publisher, 'Anatomy'));
        $neuro = $this->publishedListing($publisher, $this->deckWithNotes($publisher, 'Neuro'), [
            'title' => 'Cranial nerves',
            'description' => 'Twelve of them, in order.',
            'tags' => ['neuroanatomy'],
        ]);

        $this->anonymous()->getJson(route('marketplace.listings.index', ['q' => 'thoracic']))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $anatomy->id);

        $this->anonymous()->getJson(route('marketplace.listings.index', ['q' => 'twelve']))
            ->assertOk()
            ->assertJsonPath('data.0.id', $neuro->id);

        // "anatomy" is a tag on one and a substring of the other's tag. A tag
        // filter that matched both would make tags useless as a filter.
        $this->anonymous()->getJson(route('marketplace.listings.index', ['tag' => 'anatomy']))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $anatomy->id);
    }

    public function test_a_search_term_of_wildcards_matches_nothing(): void
    {
        $publisher = $this->account();
        $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->anonymous()->getJson(route('marketplace.listings.index', ['q' => '%']))
            ->assertOk()
            ->assertJsonCount(0, 'data');
    }

    public function test_a_listing_page_previews_notes_and_names_every_version(): void
    {
        $publisher = $this->account();
        $deck = $this->deckWithNotes($publisher);
        $listing = $this->publishedListing($publisher, $deck);

        $this->actingAsToken($this->tokenFor($publisher))
            ->postJson(route('marketplace.listings.store'), $this->publishBody($deck, [
                'changelog' => 'Two more cards.',
            ]))
            ->assertCreated();

        $response = $this->anonymous()->getJson(route('marketplace.listings.show', $listing))->assertOk();

        $this->assertSame(2, $response->json('data.latest_version'));
        $this->assertSame([2, 1], array_column($response->json('data.versions'), 'version'));
        $this->assertSame(['anatomy', 'thorax'], $response->json('data.tags'));

        // The preview carries the note types with the sample notes. Without
        // them a card cannot be rendered, and the listing page would have to
        // download the whole version — megabytes — to draw three sample cards.
        $this->assertCount(2, $response->json('preview.notes'));
        $this->assertCount(1, $response->json('preview.note_types'));
        $this->assertArrayHasKey('templates', $response->json('preview.note_types.0'));
        // Never the publisher's own guid: a clone mints its own, or cloning
        // your own listing would overwrite the notes you published.
        $this->assertArrayHasKey('source_guid', $response->json('preview.notes.0'));
        $this->assertArrayNotHasKey('guid', $response->json('preview.notes.0'));
    }

    public function test_the_update_check_answers_for_a_whole_collection_at_once(): void
    {
        $publisher = $this->account();
        $anatomy = $this->publishedListing($publisher, $this->deckWithNotes($publisher, 'Anatomy'));
        $unlisted = $this->publishedListing($publisher, $this->deckWithNotes($publisher, 'Neuro'), [
            'title' => 'Cranial nerves',
            'visibility' => Listing::VISIBILITY_UNLISTED,
        ]);
        $removed = $this->publishedListing($publisher, $this->deckWithNotes($publisher, 'Pharm'), [
            'title' => 'Beta blockers',
        ]);

        $this->actingAsToken($this->tokenFor($this->account(moderator: true)))
            ->postJson(route('moderation.listings.takedown', $removed), ['reason' => 'Scans.'])
            ->assertOk();

        $response = $this->anonymous()->getJson(route('marketplace.updates', [
            'ids' => implode(',', [$anatomy->id, $unlisted->id, $removed->id, 'not-a-uuid']),
        ]))->assertOk();

        $ids = array_column($response->json('data'), 'id');
        sort($ids);
        $expected = [$anatomy->id, $unlisted->id];
        sort($expected);

        // A deck cloned by link still gets its updates; a taken-down one simply
        // drops out, which the client reads as "no update" rather than an error
        // about a deck it is entitled to keep studying.
        $this->assertSame($expected, $ids);
        $this->assertSame(1, $response->json('data.0.latest_version'));
    }

    public function test_the_update_check_with_no_usable_ids_answers_empty(): void
    {
        $this->anonymous()->getJson(route('marketplace.updates'))
            ->assertOk()
            ->assertJsonCount(0, 'data');
    }

    public function test_a_publisher_sees_every_state_of_their_own_shelf(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->actingAsToken($this->tokenFor($this->account(moderator: true)))
            ->postJson(route('moderation.listings.takedown', $listing), ['reason' => 'Scans.'])
            ->assertOk();

        $this->actingAsToken($this->tokenFor($publisher))
            ->getJson(route('marketplace.listings.mine'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.status', Listing::STATUS_REMOVED)
            ->assertJsonPath('data.0.moderation_reason', 'Scans.');
    }
}
