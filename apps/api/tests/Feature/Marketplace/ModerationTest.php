<?php

declare(strict_types=1);

namespace Tests\Feature\Marketplace;

use App\Models\Listing;
use App\Models\ListingReport;
use App\Models\Note;
use Illuminate\Support\Str;

class ModerationTest extends MarketplaceTestCase
{
    public function test_a_takedown_stops_distribution_and_leaves_every_clone_alone(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $cloner = $this->account();
        $clonedDeck = $this->deckWithNotes($cloner, 'Thoracic anatomy (clone)');

        $this->actingAsToken($this->tokenFor($cloner))
            ->postJson(route('marketplace.listings.install', $listing), [
                'deck_id' => $clonedDeck->id,
                'version' => 1,
            ])
            ->assertCreated();

        $this->actingAsToken($this->tokenFor($this->account(moderator: true)))
            ->postJson(route('moderation.listings.takedown', $listing), ['reason' => 'Copyright claim upheld.'])
            ->assertOk()
            ->assertJsonPath('data.status', Listing::STATUS_REMOVED);

        // Distribution is off: browse, listing page and download all stop on the
        // same status column.
        $this->anonymous()->getJson(route('marketplace.listings.index'))->assertJsonCount(0, 'data');
        $this->anonymous()->getJson(route('marketplace.listings.show', $listing))->assertNotFound();
        $this->anonymous()->getJson(route('marketplace.listings.version', [$listing, 1]))->assertNotFound();

        // And the clone is untouched. It is the cloner's deck, with the cloner's
        // notes and scheduling, and a takedown has no reach into it.
        $this->assertDatabaseHas('decks', ['id' => $clonedDeck->id, 'user_id' => $cloner->id, 'deleted_at' => null]);
        $this->assertSame(2, Note::query()->where('deck_id', $clonedDeck->id)->whereNull('deleted_at')->count());
        $this->assertDatabaseHas('listing_installs', ['deck_id' => $clonedDeck->id, 'version' => 1]);
        $this->assertDatabaseCount('listing_versions', 1);
    }

    public function test_a_takedown_records_why_and_closes_the_open_reports(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));
        $moderator = $this->account(moderator: true);

        $this->actingAsToken($this->tokenFor($this->account()))
            ->postJson(route('marketplace.listings.report', $listing), [
                'reason' => 'copyright',
                'detail' => 'These are scans of a textbook.',
            ])
            ->assertCreated();

        $this->actingAsToken($this->tokenFor($moderator))
            ->postJson(route('moderation.listings.takedown', $listing), ['reason' => 'Textbook scans.'])
            ->assertOk();

        $listing->refresh();
        $this->assertSame('Textbook scans.', $listing->moderation_reason);
        $this->assertSame($moderator->id, $listing->moderated_by);
        $this->assertNotNull($listing->moderated_at);
        $this->assertSame(0, $listing->open_report_count);
        $this->assertDatabaseHas('listing_reports', [
            'listing_id' => $listing->id,
            'status' => ListingReport::STATUS_UPHELD,
            'resolved_by' => $moderator->id,
        ]);
    }

    public function test_the_queue_and_the_decisions_are_moderators_only(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));
        $token = $this->tokenFor($this->account());

        $this->actingAsToken($token)->getJson(route('moderation.reports.index'))->assertForbidden();
        $this->actingAsToken($token)
            ->postJson(route('moderation.listings.takedown', $listing), ['reason' => 'I do not like it.'])
            ->assertForbidden();

        $this->assertSame(Listing::STATUS_PUBLISHED, $listing->refresh()->status);
    }

    public function test_the_same_person_reporting_twice_files_one_report(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));
        $token = $this->tokenFor($this->account());

        foreach (['spam', 'inappropriate'] as $reason) {
            $this->actingAsToken($token)
                ->postJson(route('marketplace.listings.report', $listing), ['reason' => $reason])
                ->assertCreated();
        }

        $this->assertDatabaseCount('listing_reports', 1);
        $this->assertSame(1, $listing->refresh()->open_report_count);

        $this->actingAsToken($this->tokenFor($this->account(moderator: true)))
            ->getJson(route('moderation.reports.index'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.listing.id', $listing->id);
    }

    public function test_reporting_is_rate_limited(): void
    {
        $token = $this->tokenFor($this->account());

        // Six different listings by six different publishers, so nothing is
        // deduplicated and nothing trips the publish throttle: what stops the
        // sixth report is the report throttle, which is the only thing standing
        // between a report queue and a harassment tool.
        for ($i = 0; $i < 6; $i++) {
            $publisher = $this->account();
            $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher, 'Deck '.$i));

            $response = $this->actingAsToken($token)
                ->postJson(route('marketplace.listings.report', $listing), ['reason' => 'spam']);

            if ($i < 5) {
                $response->assertCreated();
            } else {
                $response->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
            }
        }

        $this->assertDatabaseCount('listing_reports', 5);
    }

    public function test_dismissing_a_report_leaves_the_deck_published(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->actingAsToken($this->tokenFor($this->account()))
            ->postJson(route('marketplace.listings.report', $listing), ['reason' => 'spam'])
            ->assertCreated();

        $report = ListingReport::query()->firstOrFail();

        $this->actingAsToken($this->tokenFor($this->account(moderator: true)))
            ->postJson(route('moderation.reports.dismiss', $report), ['note' => 'Not spam.'])
            ->assertOk()
            ->assertJsonPath('data.status', ListingReport::STATUS_DISMISSED);

        $listing->refresh();
        $this->assertSame(Listing::STATUS_PUBLISHED, $listing->status);
        $this->assertSame(0, $listing->open_report_count);
        $this->anonymous()->getJson(route('marketplace.listings.version', [$listing, 1]))->assertOk();
    }

    public function test_only_the_publisher_of_a_removed_deck_can_counter_notice(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->actingAsToken($this->tokenFor($this->account(moderator: true)))
            ->postJson(route('moderation.listings.takedown', $listing), ['reason' => 'Reported as scans.'])
            ->assertOk();

        $this->actingAsToken($this->tokenFor($this->account()))
            ->postJson(route('marketplace.listings.report', $listing), [
                'kind' => ListingReport::KIND_COUNTER_NOTICE,
                'reason' => 'copyright',
            ])
            ->assertForbidden();

        $this->actingAsToken($this->tokenFor($publisher))
            ->postJson(route('marketplace.listings.report', $listing), [
                'kind' => ListingReport::KIND_COUNTER_NOTICE,
                'reason' => 'copyright',
                'detail' => 'They are my own drawings.',
            ])
            ->assertCreated();

        $this->assertDatabaseHas('listing_reports', [
            'listing_id' => $listing->id,
            'kind' => ListingReport::KIND_COUNTER_NOTICE,
            'status' => ListingReport::STATUS_OPEN,
        ]);
    }

    public function test_unlisting_takes_a_deck_out_of_browse_without_breaking_its_link(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->actingAsToken($this->tokenFor($this->account(moderator: true)))
            ->postJson(route('moderation.listings.unlist', $listing), ['reason' => 'Miscategorised.'])
            ->assertOk()
            ->assertJsonPath('data.visibility', Listing::VISIBILITY_UNLISTED)
            // Still published — that is the entire difference from a takedown.
            ->assertJsonPath('data.status', Listing::STATUS_PUBLISHED);

        $this->anonymous()->getJson(route('marketplace.listings.index'))->assertJsonCount(0, 'data');
        $this->anonymous()->getJson(route('marketplace.listings.show', $listing))->assertOk();
        $this->anonymous()->getJson(route('marketplace.listings.version', [$listing, 1]))->assertOk();
    }

    public function test_the_trail_keeps_every_decision_in_order_including_the_one_that_was_reversed(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));
        $moderator = $this->account(moderator: true);

        $this->actingAsToken($this->tokenFor($moderator))
            ->postJson(route('moderation.listings.takedown', $listing), ['reason' => 'Reported as scans.'])
            ->assertOk();

        $this->actingAsToken($this->tokenFor($publisher))
            ->postJson(route('marketplace.listings.report', $listing), [
                'kind' => ListingReport::KIND_COUNTER_NOTICE,
                'reason' => 'copyright',
                'detail' => 'They are my own drawings.',
            ])
            ->assertCreated();

        $this->actingAsToken($this->tokenFor($moderator))
            ->postJson(route('moderation.listings.approve', $listing), ['note' => 'Counter-notice accepted.'])
            ->assertOk();

        // The listing's own columns hold only the last decision. The trail is
        // what still knows the deck was ever down, and why — which is the one
        // question a counter-notice is argued from.
        $this->assertSame('Counter-notice accepted.', $listing->refresh()->moderation_reason);

        $history = $this->actingAsToken($this->tokenFor($moderator))
            ->getJson(route('moderation.listings.history', $listing))
            ->assertOk()
            ->json('data');

        // Newest first, and the first two entries are the publication itself and
        // the approval a first-time publisher waits for.
        $this->assertSame(
            ['approve', 'counter_notice', 'takedown', 'approve', 'publish'],
            array_column($history, 'action'),
        );
        $this->assertSame('Reported as scans.', $history[2]['reason']);
        $this->assertSame($moderator->id, $history[2]['moderator']['id']);
        // A publisher's counter-notice is their act, not a moderator's.
        $this->assertNull($history[1]['moderator']);
    }

    public function test_the_trail_is_moderators_only(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->actingAsToken($this->tokenFor($publisher))
            ->getJson(route('moderation.listings.history', $listing))
            ->assertForbidden();
    }

    public function test_installing_a_removed_deck_is_refused(): void
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->actingAsToken($this->tokenFor($this->account(moderator: true)))
            ->postJson(route('moderation.listings.takedown', $listing), ['reason' => 'Removed.'])
            ->assertOk();

        $this->actingAsToken($this->tokenFor($this->account()))
            ->postJson(route('marketplace.listings.install', $listing), [
                'deck_id' => (string) Str::uuid(),
                'version' => 1,
            ])
            ->assertNotFound();
    }
}
