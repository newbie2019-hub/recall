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
