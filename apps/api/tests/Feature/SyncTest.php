<?php

namespace Tests\Feature;

use App\Models\Deck;
use App\Models\Review;
use App\Models\User;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class SyncTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    private User $user;

    private string $token;

    protected function setUp(): void
    {
        parent::setUp();
        $this->user = User::factory()->create(['password' => self::PASSWORD]);
        $this->token = $this->tokenFor($this->user, 'iPhone');
    }

    private function tokenFor(User $user, string $device): string
    {
        return app(AuthService::class)
            ->login($user->email, self::PASSWORD, new DeviceIdentity($device))['token']
            ->plainTextToken;
    }

    private function push(array $payload)
    {
        return $this->actingAsToken($this->token)->postJson('/api/v1/sync', $payload);
    }

    private function pull(int $cursor = 0, int $limit = 500)
    {
        return $this->actingAsToken($this->token)->getJson("/api/v1/sync?cursor={$cursor}&limit={$limit}");
    }

    private function deck(string $name, int $updatedAt, ?string $id = null): array
    {
        return [
            'id' => $id ?? (string) Str::uuid(),
            'name' => $name,
            'retention_target' => 0.9,
            'new_per_day' => 20,
            'client_updated_at' => $updatedAt,
        ];
    }

    public function test_a_push_comes_back_on_a_pull_in_the_order_it_was_written(): void
    {
        $first = $this->deck('Anatomy', 1_700_000_001_000);
        $second = $this->deck('Pharmacology', 1_700_000_002_000);

        $this->push(['decks' => [$first, $second]])
            ->assertOk()
            ->assertJsonPath('data.applied.decks', 2);

        $response = $this->pull()->assertOk();
        $this->assertSame(['Anatomy', 'Pharmacology'], array_column($response->json('data.decks'), 'name'));
        $this->assertNotNull($response->json('next_cursor'));

        // A caught-up device pulls nothing and is told so.
        $this->pull($response->json('next_cursor'))
            ->assertOk()
            ->assertJsonPath('data.decks', [])
            ->assertJsonPath('next_cursor', null);
    }

    public function test_pushing_the_same_rows_twice_changes_nothing(): void
    {
        $deck = $this->deck('Anatomy', 1_700_000_001_000);
        $this->push(['decks' => [$deck]])->assertOk();
        $cursor = $this->pull()->json('next_cursor');

        // The identical row again: not newer, so not applied, and crucially no
        // new revision — every other device must stay asleep.
        $this->push(['decks' => [$deck]])
            ->assertOk()
            ->assertJsonPath('data.applied', [])
            ->assertJsonPath('data.skipped.decks', [$deck['id']]);

        $this->pull($cursor)->assertJsonPath('next_cursor', null);
        $this->assertSame(1, Deck::count());
    }

    public function test_the_later_edit_wins_and_the_earlier_one_is_reported_as_skipped(): void
    {
        $id = (string) Str::uuid();
        $this->push(['decks' => [$this->deck('Anatomy', 1_700_000_005_000, $id)]])->assertOk();

        // A phone that was offline, pushing an older edit of the same deck.
        $this->push(['decks' => [$this->deck('Anatomie', 1_700_000_001_000, $id)]])
            ->assertOk()
            ->assertJsonPath('data.skipped.decks', [$id]);
        $this->assertSame('Anatomy', Deck::find($id)->name);

        $this->push(['decks' => [$this->deck('Thorax', 1_700_000_009_000, $id)]])
            ->assertOk()
            ->assertJsonPath('data.applied.decks', 1);
        $this->assertSame('Thorax', Deck::find($id)->name);
    }

    public function test_a_delete_is_a_tombstone_a_pull_can_report(): void
    {
        $id = (string) Str::uuid();
        $this->push(['decks' => [$this->deck('Anatomy', 1_700_000_001_000, $id)]])->assertOk();
        $cursor = $this->pull()->json('next_cursor');

        $this->push(['decks' => [[...$this->deck('Anatomy', 1_700_000_002_000, $id), 'deleted' => true]]])
            ->assertOk();

        // A device that was offline for the delete has to learn about it, which
        // a hard delete could never have told it.
        $response = $this->pull($cursor)->assertOk();
        $this->assertSame($id, $response->json('data.decks.0.id'));
        $this->assertTrue($response->json('data.decks.0.deleted'));
    }

    public function test_reviews_are_append_only_and_a_retried_push_does_not_double_the_log(): void
    {
        $review = [
            'id' => (string) Str::uuid(),
            'card_id' => 'note-1:0',
            'client_ts' => 1_700_000_100_000,
            'rating' => 3,
            'duration_ms' => 4_200,
        ];

        $this->push(['reviews' => [$review]])->assertOk()->assertJsonPath('data.applied.reviews', 1);

        // The same push again — a retry after a dropped connection, which is the
        // normal case on mobile, not the exceptional one.
        $this->push(['reviews' => [[...$review, 'rating' => 1]]])
            ->assertOk()
            ->assertJsonPath('data.applied', [])
            ->assertJsonPath('data.skipped.reviews', [$review['id']]);

        $this->assertSame(1, Review::count());
        // And the log was not rewritten by the retry's different rating.
        $this->assertSame(3, Review::first()->rating);
    }

    public function test_a_review_follows_its_card_when_a_note_type_change_renames_it(): void
    {
        // A card id is `<note id>:<ord>`, so remapping an ordinal renames the
        // card — and the answers given to it have to follow, or the next device
        // to sync rebuilds its scheduling from a log pointing at the wrong card.
        $id = (string) Str::uuid();
        $this->push(['reviews' => [[
            'id' => $id, 'card_id' => 'n:0', 'client_ts' => 1_700_000_000_000, 'rating' => 3,
        ]]])->assertOk();

        $this->push(['reviews' => [[
            'id' => $id, 'card_id' => 'n:1', 'client_ts' => 1_700_000_000_000, 'rating' => 3,
        ]]])->assertOk();

        $review = Review::first();
        $this->assertSame('n:1', $review->card_id, 'the pointer moved');
        $this->assertSame(3, $review->rating, 'and nothing else did');
        $this->assertSame(1, Review::count(), 'no second row');
    }

    public function test_a_review_cannot_be_repointed_at_another_note(): void
    {
        // The guard that makes the exception safe to allow at all: a rename is
        // a new ordinal on the same note. Anything else is a client trying to
        // graft one card's history onto another.
        $id = (string) Str::uuid();
        $this->push(['reviews' => [[
            'id' => $id, 'card_id' => 'n:0', 'client_ts' => 1_700_000_000_000, 'rating' => 3,
        ]]])->assertOk();

        $this->push(['reviews' => [[
            'id' => $id, 'card_id' => 'somebody-else:0', 'client_ts' => 1_700_000_000_000, 'rating' => 1,
        ]]])->assertOk();

        $review = Review::first();
        $this->assertSame('n:0', $review->card_id, 'refused');
        $this->assertSame(3, $review->rating, 'and the outcome is still untouchable');
    }

    public function test_a_wrong_client_clock_is_clamped_not_rewritten(): void
    {
        $this->push(['reviews' => [[
            'id' => (string) Str::uuid(), 'card_id' => 'n:0',
            'client_ts' => 4_102_444_800_000, // the year 2100, per a bad phone clock
            'rating' => 3,
        ]]])->assertOk();

        $review = Review::first();
        $this->assertLessThanOrEqual($review->server_received_at, $review->client_ts,
            'a review cannot have happened after the server received it');
        $this->assertGreaterThan(1_699_999_999_000, $review->client_ts,
            'and it is pulled to the boundary rather than zeroed');
    }

    public function test_a_notes_fields_survive_the_round_trip_as_an_object(): void
    {
        // The regression this exists for: `writableOnly` encoded arrays, and the
        // model's `array` cast encoded the result again, so the column held a
        // JSON string of JSON and a pull handed the client a string where it
        // expects an object. Nothing caught it because no test had ever pushed
        // a note with fields in it.
        $deck = $this->deck('Thorax', 1_700_000_100_000);
        $noteType = [
            'id' => (string) Str::uuid(),
            'name' => 'Basic',
            'fields' => ['Front', 'Back'],
            'templates' => [['name' => 'Card 1', 'qfmt' => '{{Front}}', 'afmt' => '{{Back}}']],
            'css' => '.card { font-size: 20px }',
            'kind' => 'standard',
            'sort_field' => 0,
            'field_config' => [],
            'anki_extra' => [],
            'builtin' => false,
            'client_updated_at' => 1_700_000_100_000,
        ];
        $note = [
            'id' => (string) Str::uuid(),
            'guid' => 'abc12345',
            'note_type_id' => $noteType['id'],
            'deck_id' => $deck['id'],
            'fields' => ['Front' => 'aortic valve', 'Back' => 'between LV and aorta'],
            'tags' => 'anatomy::thorax',
            'client_updated_at' => 1_700_000_100_000,
        ];

        $this->push(['decks' => [$deck], 'note_types' => [$noteType], 'notes' => [$note]])->assertOk();

        $pulled = $this->pull()->assertOk()->json('data.notes.0');
        $this->assertSame(['Front' => 'aortic valve', 'Back' => 'between LV and aorta'], $pulled['fields']);

        $pulledType = $this->pull()->json('data.note_types.0');
        $this->assertSame(['Front', 'Back'], $pulledType['fields']);
        $this->assertSame('{{Front}}', $pulledType['templates'][0]['qfmt']);
    }

    public function test_an_empty_string_in_a_pushed_row_stays_an_empty_string(): void
    {
        // The bug: Laravel converts "" to null on every request, which is right
        // for a human leaving a field blank and wrong for a device reporting a
        // row. All seven built-in note types ship with `css: ''`, so the first
        // sync of a brand-new account pushed a NULL into a NOT NULL column and
        // got a 500 — on the one endpoint with no other way to make progress.
        // A note with no tags failed identically.
        //
        // Every fixture in this file used to carry non-empty text, which is
        // exactly why nothing caught it. This one is deliberately empty.
        $deck = $this->deck('Thorax', 1_700_000_100_000);
        $noteType = [
            'id' => (string) Str::uuid(),
            'name' => 'Basic',
            'fields' => ['Front', 'Back'],
            'templates' => [['name' => 'Card 1', 'qfmt' => '{{Front}}', 'afmt' => '{{Back}}']],
            'css' => '',
            'kind' => 'standard',
            'sort_field' => 0,
            'field_config' => [],
            'anki_extra' => [],
            'builtin' => true,
            'client_updated_at' => 1_700_000_100_000,
        ];
        $note = [
            'id' => (string) Str::uuid(),
            'guid' => 'abc12345',
            'note_type_id' => $noteType['id'],
            'deck_id' => $deck['id'],
            'fields' => ['Front' => 'mitral valve', 'Back' => ''],
            'tags' => '',
            'client_updated_at' => 1_700_000_100_000,
        ];

        $this->push(['decks' => [$deck], 'note_types' => [$noteType], 'notes' => [$note]])->assertOk();

        $pulled = $this->pull()->assertOk()->json('data');
        $this->assertSame('', $pulled['note_types'][0]['css']);
        $this->assertSame('', $pulled['notes'][0]['tags']);
        $this->assertSame('', $pulled['notes'][0]['fields']['Back']);
    }

    public function test_a_chosen_due_date_and_a_forget_reach_the_other_device(): void
    {
        // The bug this exists for: `card_states` carries only what a person
        // decided, which is right — but "set due date" wrote the local FSRS
        // cache instead, so a date chosen on a laptop was invisible to the
        // phone, which rebuilds every schedule from the review log. A forget
        // would have vanished the same way.
        $deck = $this->deck('Thorax', 1_700_000_100_000);
        $cardState = [
            'id' => 'note-1:0',
            'note_id' => (string) Str::uuid(),
            'ord' => 0,
            'suspended' => false,
            'flag' => 0,
            'deck_id' => $deck['id'],
            'due_override' => 1_800_000_000_000,
            'forgotten_at' => 1_750_000_000_000,
            'client_updated_at' => 1_700_000_200_000,
        ];

        $this->push(['decks' => [$deck], 'card_states' => [$cardState]])->assertOk();

        $pulled = $this->pull()->assertOk()->json('data.card_states.0');
        $this->assertSame(1_800_000_000_000, $pulled['due_override']);
        $this->assertSame(1_750_000_000_000, $pulled['forgotten_at']);
    }

    public function test_clearing_an_override_travels_as_null_rather_than_being_ignored(): void
    {
        // A cleared override has to be a change like any other. If a null were
        // dropped as "nothing to say", undoing a forget on one device would
        // leave the card forgotten everywhere else, for good.
        $deck = $this->deck('Thorax', 1_700_000_100_000);
        $base = [
            'id' => 'note-1:0',
            'note_id' => (string) Str::uuid(),
            'ord' => 0,
            'suspended' => false,
            'flag' => 0,
            'deck_id' => $deck['id'],
        ];

        $this->push(['decks' => [$deck], 'card_states' => [
            [...$base, 'forgotten_at' => 1_750_000_000_000, 'client_updated_at' => 1_700_000_200_000],
        ]])->assertOk();

        $this->push(['card_states' => [
            [...$base, 'forgotten_at' => null, 'client_updated_at' => 1_700_000_300_000],
        ]])->assertOk();

        $this->assertNull($this->pull()->json('data.card_states.0.forgotten_at'));
    }

    public function test_a_notes_creation_time_is_its_own_and_not_the_servers(): void
    {
        $deck = $this->deck('Thorax', 1_700_000_100_000);
        $noteType = [
            'id' => (string) Str::uuid(),
            'name' => 'Basic',
            'fields' => ['Front', 'Back'],
            'templates' => [['name' => 'Card 1', 'qfmt' => '{{Front}}', 'afmt' => '{{Back}}']],
            'css' => '',
            'kind' => 'standard',
            'sort_field' => 0,
            'field_config' => [],
            'anki_extra' => [],
            'builtin' => false,
            'client_updated_at' => 1_700_000_100_000,
        ];
        $note = [
            'id' => (string) Str::uuid(),
            'guid' => 'abc12345',
            'note_type_id' => $noteType['id'],
            'deck_id' => $deck['id'],
            'fields' => ['Front' => 'mitral valve', 'Back' => 'between LA and LV'],
            'tags' => '',
            // Added long before it was last edited: the whole point of the
            // column is that "added" and "touched" are different questions.
            'client_created_at' => 1_600_000_000_000,
            'client_updated_at' => 1_700_000_100_000,
        ];

        $this->push(['decks' => [$deck], 'note_types' => [$noteType], 'notes' => [$note]])->assertOk();

        $pulled = $this->pull()->assertOk()->json('data.notes.0');
        $this->assertSame(1_600_000_000_000, $pulled['client_created_at']);
        $this->assertSame(1_700_000_100_000, $pulled['client_updated_at']);
    }

    public function test_an_imported_answer_keeps_its_own_date_instead_of_being_floored(): void
    {
        // A .apkg carries answers from years before this app existed. Flooring
        // them at the epoch would compress a decade of studying onto one
        // afternoon and hand FSRS a history that never happened — which is the
        // history Phase 4 exists to carry.
        $inTwentyFifteen = 1_420_070_400_000;

        $this->push(['reviews' => [[
            'id' => 'card-id-here:0@'.$inTwentyFifteen,
            'card_id' => 'card-id-here:0',
            'client_ts' => $inTwentyFifteen,
            'rating' => 3,
            'imported' => true,
        ]]])->assertOk();

        $this->assertSame($inTwentyFifteen, (int) Review::first()->client_ts);
    }

    public function test_a_review_id_longer_than_a_uuid_is_accepted(): void
    {
        // An answer recorded here gets a UUID; one replayed out of an .apkg is
        // `<note>:<ord>@<ts>`, which is longer than char(36) and is derived from
        // its content precisely so a re-import cannot duplicate it.
        $id = Str::uuid().':0@1420070400000';
        $this->assertGreaterThan(36, strlen($id));

        $this->push(['reviews' => [[
            'id' => $id, 'card_id' => 'n:0', 'client_ts' => 1_420_070_400_000,
            'rating' => 3, 'imported' => true,
        ]]])->assertOk();

        $this->assertSame($id, Review::first()->id);
    }

    public function test_a_page_is_capped_on_total_rows_and_resumes_exactly(): void
    {
        $decks = [];
        for ($i = 0; $i < 12; $i++) {
            $decks[] = $this->deck("Deck {$i}", 1_700_000_000_000 + $i);
        }
        $this->push(['decks' => $decks])->assertOk();

        $first = $this->pull(0, 5)->assertOk();
        $this->assertCount(5, $first->json('data.decks'));
        $this->assertTrue($first->json('has_more'));

        $second = $this->pull($first->json('next_cursor'), 5)->assertOk();
        $this->assertCount(5, $second->json('data.decks'));

        $third = $this->pull($second->json('next_cursor'), 5)->assertOk();
        $this->assertCount(2, $third->json('data.decks'));
        $this->assertFalse($third->json('has_more'));

        // Twelve distinct decks across three pages — nothing repeated, nothing
        // skipped at a page boundary.
        $names = array_merge(
            array_column($first->json('data.decks'), 'name'),
            array_column($second->json('data.decks'), 'name'),
            array_column($third->json('data.decks'), 'name'),
        );
        $this->assertCount(12, array_unique($names));
    }

    public function test_one_account_never_sees_another_accounts_rows(): void
    {
        $this->push(['decks' => [$this->deck('Mine', 1_700_000_001_000)]])->assertOk();

        $stranger = User::factory()->create(['password' => self::PASSWORD]);
        $this->actingAsToken($this->tokenFor($stranger, 'Their laptop'))
            ->getJson('/api/v1/sync?cursor=0')
            ->assertOk()
            ->assertJsonPath('data.decks', []);

        // And their counter is their own, so my writes do not push their cursor
        // past rows they have never seen.
        $this->assertSame(0, $stranger->fresh()->sync_revision);
    }

    public function test_a_pull_advances_the_device_cursor_but_never_rewinds_it(): void
    {
        $this->push(['decks' => [$this->deck('Anatomy', 1_700_000_001_000)]])->assertOk();
        $cursor = $this->pull()->json('next_cursor');

        $device = $this->user->devices()->first();
        $this->assertSame($cursor, $device->fresh()->cursor);

        // Re-requesting an older page is normal: the client failed to apply it.
        $this->pull(0)->assertOk();
        $this->assertSame($cursor, $device->fresh()->cursor, 'the account screen does not go backwards');
    }

    public function test_sync_requires_a_token(): void
    {
        $this->getJson('/api/v1/sync')->assertStatus(401)->assertJsonPath('error.code', 'unauthenticated');
        $this->postJson('/api/v1/sync', [])->assertStatus(401);
    }
}
