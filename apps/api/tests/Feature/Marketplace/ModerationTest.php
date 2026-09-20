<?php

declare(strict_types=1);

namespace Tests\Feature\Marketplace;

use App\Models\Listing;
use App\Models\ListingReport;
use App\Models\Note;
use App\Services\Marketplace\ModerationService;
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

    // ── two moderators, one queue (Phase 11) ──────────────────────────────

    /** A published listing with one open report against it. */
    private function openReport(): ListingReport
    {
        $publisher = $this->account();
        $listing = $this->publishedListing($publisher, $this->deckWithNotes($publisher));

        $this->actingAsToken($this->tokenFor($this->account()))
            ->postJson(route('marketplace.listings.report', $listing), ['reason' => 'spam'])
            ->assertCreated();

        return ListingReport::query()->where('listing_id', $listing->id)->sole();
    }

    public function test_two_moderators_cannot_work_the_same_report(): void
    {
        // The failure is not a crash: it is two people writing the same
        // decision, or one dismissing what the other is still reading. The
        // claim is decided in the database, because two browsers reading
        // "unclaimed" in the same second both believe it.
        $first = $this->account(moderator: true);
        $second = $this->account(moderator: true);
        $report = $this->openReport();

        $this->actingAsToken($this->tokenFor($first))
            ->postJson(route('moderation.reports.claim', $report))
            ->assertOk()
            ->assertJsonPath('data.claimed', true);

        $this->actingAsToken($this->tokenFor($second))
            ->postJson(route('moderation.reports.claim', $report))
            ->assertStatus(403);

        $this->actingAsToken($this->tokenFor($second))
            ->getJson(route('moderation.reports.index'))
            ->assertOk()
            ->assertJsonPath('data.0.claimed_by.id', $first->id)
            ->assertJsonPath('data.0.mine', false);
    }

    public function test_a_claim_can_be_handed_back(): void
    {
        $first = $this->account(moderator: true);
        $second = $this->account(moderator: true);
        $report = $this->openReport();

        $this->actingAsToken($this->tokenFor($first))
            ->postJson(route('moderation.reports.claim', $report))->assertOk();
        $this->actingAsToken($this->tokenFor($first))
            ->deleteJson(route('moderation.reports.release', $report))->assertOk();

        $this->actingAsToken($this->tokenFor($second))
            ->postJson(route('moderation.reports.claim', $report))
            ->assertOk();
    }

    public function test_a_stale_claim_does_not_park_a_report_forever(): void
    {
        // A moderator who claims three reports and shuts their laptop must not
        // take them out of the queue for good, and an explicit release is the
        // step everybody forgets.
        $gone = $this->account(moderator: true);
        $working = $this->account(moderator: true);
        $report = $this->openReport();

        $this->actingAsToken($this->tokenFor($gone))
            ->postJson(route('moderation.reports.claim', $report))->assertOk();

        $this->travel(ModerationService::CLAIM_MINUTES + 1)->minutes();

        $this->actingAsToken($this->tokenFor($working))
            ->postJson(route('moderation.reports.claim', $report))
            ->assertOk();
    }

    public function test_the_queue_pages_on_a_key_rather_than_an_offset(): void
    {
        // Offset paging re-shows a report somebody already passed the moment a
        // new one arrives above it. In a queue whose job is "nothing is
        // missed", that is the failure mode.
        $moderator = $this->account(moderator: true);
        $ids = collect(range(1, 3))->map(fn (): string => $this->openReport()->id)->all();

        $first = $this->actingAsToken($this->tokenFor($moderator))
            ->getJson(route('moderation.reports.index', ['limit' => 2]))
            ->assertOk();

        $cursor = $first->json('next_cursor');
        $this->assertNotNull($cursor);
        $this->assertStringContainsString('|', $cursor, 'a timestamp and an id, not a row number');

        $second = $this->actingAsToken($this->tokenFor($moderator))
            ->getJson(route('moderation.reports.index', ['limit' => 2, 'cursor' => $cursor]))
            ->assertOk();

        $seen = array_merge($first->json('data.*.id'), $second->json('data.*.id'));
        $this->assertCount(3, array_unique($seen), 'every report once, none twice');
        $this->assertEqualsCanonicalizing($ids, array_values(array_unique($seen)));
    }
}
