<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Friendship;
use App\Models\Review;
use App\Models\User;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * Friends, presence, and the one board in this app that compares two people.
 *
 * The failures worth guarding here are all quiet ones. A relationship stored
 * twice looks fine until one copy is removed and the other keeps granting.
 * A status stored instead of derived looks fine until it is read by the person
 * on the other end and offers them a button that is not theirs. And a board
 * assembled per friend looks fine on a test account with two of them.
 */
class FriendsTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    public function test_a_request_is_accepted_by_the_person_it_was_addressed_to(): void
    {
        $asker = $this->account('asker@example.test');
        $asked = $this->account('asked@example.test');

        $created = $this->actingAsToken($this->tokenFor($asker))
            ->postJson(route('friends.store'), ['email' => 'ASKED@example.test'])
            ->assertCreated()
            ->assertJsonPath('data.status', Friendship::STATUS_PENDING_OUT)
            ->assertJsonPath('data.user.id', $asked->id)
            ->json('data.id');

        $this->actingAsToken($this->tokenFor($asked))
            ->postJson(route('friends.accept', $created))
            ->assertOk()
            ->assertJsonPath('data.status', Friendship::STATUS_ACCEPTED)
            // The other person, from whichever end you read it.
            ->assertJsonPath('data.user.id', $asker->id);

        $this->actingAsToken($this->tokenFor($asker))
            ->getJson(route('friends.index'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.status', Friendship::STATUS_ACCEPTED);
    }

    public function test_the_same_row_reads_as_out_to_one_side_and_in_to_the_other(): void
    {
        // One row, two documents. A `status` column would have to be right for
        // both people at once, and it cannot be.
        $asker = $this->account('asker@example.test');
        $asked = $this->account('asked@example.test');
        $this->request($asker, $asked);

        $this->actingAsToken($this->tokenFor($asker))
            ->getJson(route('friends.index'))
            ->assertOk()
            ->assertJsonPath('data.0.status', Friendship::STATUS_PENDING_OUT)
            ->assertJsonPath('data.0.user.name', $asked->name);

        $this->actingAsToken($this->tokenFor($asked))
            ->getJson(route('friends.index'))
            ->assertOk()
            ->assertJsonPath('data.0.status', Friendship::STATUS_PENDING_IN)
            ->assertJsonPath('data.0.user.name', $asker->name);

        $this->assertSame(1, Friendship::query()->count(), 'one relationship is one row');
    }

    public function test_a_request_addressed_to_somebody_else_cannot_be_accepted(): void
    {
        $asker = $this->account('asker@example.test');
        $asked = $this->account('asked@example.test');
        $stranger = $this->account('stranger@example.test');
        $friendship = $this->request($asker, $asked);

        // The requester saying yes to themselves would be a friendship the
        // other person never agreed to.
        $this->actingAsToken($this->tokenFor($asker))
            ->postJson(route('friends.accept', $friendship))
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');

        // A stranger gets a 404, not a 403: a 403 on a real id would be a way
        // to ask the server which friendship ids exist.
        $this->actingAsToken($this->tokenFor($stranger))
            ->postJson(route('friends.accept', $friendship))
            ->assertNotFound()
            ->assertJsonPath('error.code', 'not_found');

        $this->assertNull($friendship->fresh()->accepted_at);
    }

    public function test_either_party_can_remove_the_friendship(): void
    {
        $asker = $this->account('asker@example.test');
        $asked = $this->account('asked@example.test');

        // The addressee declining.
        $declined = $this->request($asker, $asked);
        $this->actingAsToken($this->tokenFor($asked))
            ->deleteJson(route('friends.destroy', $declined))
            ->assertOk();
        $this->assertSame(0, Friendship::query()->count());

        // And the requester walking away from an accepted one. Same row, same
        // endpoint — a friendship one side cannot leave is not one.
        $accepted = $this->request($asker, $asked);
        $accepted->forceFill(['accepted_at' => now()])->save();

        $this->actingAsToken($this->tokenFor($asker))
            ->deleteJson(route('friends.destroy', $accepted))
            ->assertOk();
        $this->assertSame(0, Friendship::query()->count());
    }

    public function test_asking_twice_answers_with_the_row_that_already_exists(): void
    {
        // Somebody who is not sure the first tap registered taps again. That
        // must not be a duplicate, and it must not be a 500 off the unique
        // index either.
        $asker = $this->account('asker@example.test');
        $asked = $this->account('asked@example.test');

        $first = $this->actingAsToken($this->tokenFor($asker))
            ->postJson(route('friends.store'), ['email' => $asked->email])
            ->assertCreated()->json('data.id');

        $second = $this->actingAsToken($this->tokenFor($asker))
            ->postJson(route('friends.store'), ['email' => $asked->email])
            ->assertCreated()->json('data.id');

        $this->assertSame($first, $second);

        // And from the other direction, where the row is stored the other way
        // round — still one relationship.
        $this->actingAsToken($this->tokenFor($asked))
            ->postJson(route('friends.store'), ['email' => $asker->email])
            ->assertCreated()
            ->assertJsonPath('data.id', $first)
            ->assertJsonPath('data.status', Friendship::STATUS_PENDING_IN);

        $this->assertSame(1, Friendship::query()->count());
    }

    public function test_an_unknown_address_and_your_own_are_both_refused(): void
    {
        $user = $this->account('me@example.test');

        // One message for every reason a request cannot be sent — it never
        // says "no such user". The honest caveat is in the controller: a
        // *successful* request reveals the account anyway, so the throttle is
        // the real defence, not this wording.
        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('friends.store'), ['email' => 'nobody@example.test'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonPath('error.message', 'We could not send a request to that address.');

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('friends.store'), ['email' => 'ME@example.test'])
            ->assertStatus(422);

        $this->assertSame(0, Friendship::query()->count());
    }

    public function test_the_board_counts_the_caller_and_accepted_friends_only(): void
    {
        $user = $this->account('me@example.test');
        $friend = $this->account('friend@example.test');
        $pending = $this->account('pending@example.test');
        $stranger = $this->account('stranger@example.test');

        $this->request($user, $friend)->forceFill(['accepted_at' => now()])->save();
        $this->request($user, $pending);

        $this->review($user, now()->subDay(), 90_000);
        $this->review($user, now()->subDay(), 30_000);
        $this->review($friend, now()->subHours(2), 60_000);
        $this->review($pending, now()->subHour(), 600_000);
        $this->review($stranger, now()->subHour(), 600_000);

        $response = $this->actingAsToken($this->tokenFor($user))
            ->getJson(route('friends.leaderboard'))
            ->assertOk()
            ->assertJsonCount(2, 'data.rows')
            ->assertJsonPath('data.rows.0.user_id', $user->id)
            ->assertJsonPath('data.rows.0.reviews', 2)
            // Two minutes exactly, so a rounding slip shows up as a whole one.
            ->assertJsonPath('data.rows.0.minutes', 2)
            ->assertJsonPath('data.rows.0.is_you', true)
            ->assertJsonPath('data.rows.1.user_id', $friend->id)
            ->assertJsonPath('data.rows.1.is_you', false);

        $this->assertNotNull($response->json('data.period_start'));
        $this->assertNotNull($response->json('data.period_end'));
    }

    public function test_the_board_is_a_window_and_keeps_you_on_it_at_zero(): void
    {
        $user = $this->account('me@example.test');
        $friend = $this->account('friend@example.test');
        $this->request($user, $friend)->forceFill(['accepted_at' => now()])->save();

        // Last month. Inside an all-time board, outside this one.
        $this->review($user, now()->subDays(20), 300_000);
        $this->review($user, now()->subDays(19), 300_000);
        $this->review($friend, now()->subDays(2), 60_000);

        $this->actingAsToken($this->tokenFor($user))
            ->getJson(route('friends.leaderboard', ['days' => 7]))
            ->assertOk()
            ->assertJsonPath('data.rows.0.user_id', $friend->id)
            // Still listed, still findable, at zero. A board you fall off tells
            // you nothing on the week you needed it most.
            ->assertJsonPath('data.rows.1.user_id', $user->id)
            ->assertJsonPath('data.rows.1.reviews', 0)
            ->assertJsonPath('data.rows.1.minutes', 0);

        // Widen the window and the old sessions are back inside it — and
        // being back inside it is what moves the caller to the top.
        $this->actingAsToken($this->tokenFor($user))
            ->getJson(route('friends.leaderboard', ['days' => 30]))
            ->assertOk()
            ->assertJsonPath('data.rows.0.user_id', $user->id)
            ->assertJsonPath('data.rows.0.reviews', 2)
            ->assertJsonPath('data.rows.0.minutes', 10);

        $this->actingAsToken($this->tokenFor($user))
            ->getJson(route('friends.leaderboard', ['days' => 90]))
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_the_board_costs_the_same_number_of_queries_however_many_friends(): void
    {
        // The N+1 this is here to catch is a count per friend, which is
        // invisible on a test account with two of them.
        $user = $this->account('me@example.test');

        foreach (range(1, 6) as $n) {
            $friend = $this->account("friend{$n}@example.test");
            $this->request($user, $friend)->forceFill(['accepted_at' => now()])->save();
            $this->review($friend, now()->subHour(), 60_000);
        }

        $token = $this->tokenFor($user);

        // Only the board's own reads are counted — the auth plumbing around it
        // is fixed and not what this is about.
        $queries = 0;
        DB::listen(function (QueryExecuted $query) use (&$queries): void {
            if (str_contains($query->sql, 'friendships') || str_contains($query->sql, 'reviews')) {
                $queries++;
            }
        });

        $this->actingAsToken($token)
            ->getJson(route('friends.leaderboard'))
            ->assertOk()
            ->assertJsonCount(7, 'data.rows');

        // The friend id set, and one grouped aggregate over all of them. Seven
        // friends or seven hundred, this number does not move.
        $this->assertSame(2, $queries, "the board ran {$queries} queries");
    }

    public function test_online_is_derived_from_the_heartbeat(): void
    {
        $user = $this->account('me@example.test');
        $friend = $this->account('friend@example.test');
        $this->request($user, $friend)->forceFill(['accepted_at' => now()])->save();

        // Never seen: no dot, and no fabricated timestamp either.
        $this->actingAsToken($this->tokenFor($user))
            ->getJson(route('friends.index'))
            ->assertOk()
            ->assertJsonPath('data.0.online', false)
            ->assertJsonPath('data.0.last_seen_at', null);

        // Any authenticated request is the heartbeat. No channel, no socket.
        $this->actingAsToken($this->tokenFor($friend))->getJson(route('auth.me'))->assertOk();
        $this->assertNotNull($friend->fresh()->last_seen_at);

        $this->actingAsToken($this->tokenFor($user))
            ->getJson(route('friends.index'))
            ->assertOk()
            ->assertJsonPath('data.0.online', true);

        // Ten minutes of silence and the dot goes out, without anything having
        // to write a row to say so.
        $friend->forceFill(['last_seen_at' => now()->subMinutes(10)])->save();

        $this->actingAsToken($this->tokenFor($user))
            ->getJson(route('friends.index'))
            ->assertOk()
            ->assertJsonPath('data.0.online', false);
    }

    public function test_the_heartbeat_writes_at_most_once_a_minute(): void
    {
        // Without the cache guard every review push writes to `users`, which
        // turns a read-mostly table into the busiest one in the database to
        // move a timestamp that only has to be roughly right.
        $user = $this->account('me@example.test');
        $token = $this->tokenFor($user);

        $this->actingAsToken($token)->getJson(route('auth.me'))->assertOk();
        $first = $user->fresh()->last_seen_at;

        $this->travel(30)->seconds();
        $this->actingAsToken($token)->getJson(route('auth.me'))->assertOk();
        $this->assertTrue($first->equalTo($user->fresh()->last_seen_at), 'the second request wrote nothing');

        $this->travel(90)->seconds();
        $this->actingAsToken($token)->getJson(route('auth.me'))->assertOk();
        $this->assertTrue($user->fresh()->last_seen_at->gt($first));

        $this->travelBack();
    }

    public function test_a_heartbeat_is_not_an_edit(): void
    {
        // It goes through the base query builder precisely so it does not move
        // `updated_at`: `Eloquent\Builder::update()` calls
        // `addUpdatedAtColumn()`, so the obvious spelling would stamp every
        // account in the system once a minute and make "when did this account
        // last change" mean nothing.
        $user = $this->account('me@example.test');
        $token = $this->tokenFor($user);
        $edited = $user->fresh()->updated_at;

        $this->travel(90)->seconds();
        $this->actingAsToken($token)->getJson(route('auth.me'))->assertOk();

        $fresh = $user->fresh();
        $this->assertNotNull($fresh->last_seen_at, 'the heartbeat landed');
        $this->assertTrue($edited->equalTo($fresh->updated_at), 'and moved nothing else');

        $this->travelBack();
    }

    public function test_every_friends_endpoint_is_closed_to_a_stranger(): void
    {
        $asker = $this->account('asker@example.test');
        $asked = $this->account('asked@example.test');
        $friendship = $this->request($asker, $asked);

        $calls = [
            fn () => $this->getJson(route('friends.index')),
            fn () => $this->postJson(route('friends.store'), ['email' => $asked->email]),
            fn () => $this->postJson(route('friends.accept', $friendship)),
            fn () => $this->deleteJson(route('friends.destroy', $friendship)),
            fn () => $this->getJson(route('friends.leaderboard')),
        ];

        foreach ($calls as $call) {
            Auth::forgetGuards();
            $this->flushHeaders();

            $call()->assertStatus(401)->assertJsonPath('error.code', 'unauthenticated');
        }

        $this->assertNotNull($friendship->fresh());
    }

    private function account(?string $email = null): User
    {
        return User::factory()->create([
            'password' => self::PASSWORD,
            ...($email !== null ? ['email' => $email] : []),
        ]);
    }

    private function tokenFor(User $user): string
    {
        return app(AuthService::class)
            ->login($user->email, self::PASSWORD, new DeviceIdentity('iPhone'))['token']
            ->plainTextToken;
    }

    /** A request sent, not yet answered — the state most of these start from. */
    private function request(User $requester, User $addressee): Friendship
    {
        return Friendship::query()->create([
            'requester_id' => $requester->id,
            'addressee_id' => $addressee->id,
        ]);
    }

    private function review(User $user, \DateTimeInterface $at, int $durationMs): Review
    {
        return Review::query()->create([
            'id' => (string) Str::uuid(),
            'user_id' => $user->id,
            'card_id' => (string) Str::uuid(),
            'client_ts' => $at->getTimestamp() * 1000,
            'server_received_at' => $at->getTimestamp() * 1000,
            'rating' => 3,
            'duration_ms' => $durationMs,
            'revision' => 1,
        ]);
    }
}
