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

class AccountDeletionTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'left-anterior-descending';

    /**
     * @return array{0: User, 1: string}
     */
    private function signedInUser(string $email = 'yvan@example.test'): array
    {
        $user = User::factory()->create(['email' => $email, 'password' => self::PASSWORD]);
        $session = app(AuthService::class)->login(
            $email,
            self::PASSWORD,
            new DeviceIdentity('Chrome on macOS', null, 'web'),
        );

        return [$user, $session['token']->plainTextToken];
    }

    /** No factories exist for these yet, and one deletion test is not the place to introduce them. */
    private function deckFor(User $user): Deck
    {
        return Deck::query()->create([
            'id' => Str::uuid()->toString(),
            'user_id' => $user->id,
            'name' => 'Thorax',
            'revision' => 1,
            'client_updated_at' => 1_700_000_000_000,
        ]);
    }

    private function reviewFor(User $user, string $cardId): Review
    {
        return Review::query()->create([
            'id' => Str::uuid()->toString(),
            'user_id' => $user->id,
            'card_id' => $cardId,
            'client_ts' => 1_700_000_000_000,
            'server_received_at' => 1_700_000_000_001,
            'rating' => 3,
            'revision' => 1,
        ]);
    }

    public function test_the_wrong_password_deletes_nothing(): void
    {
        [$user, $token] = $this->signedInUser();

        $this->actingAsToken($token)
            ->deleteJson('/api/v1/account', ['password' => 'not-the-password'])
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'invalid_credentials');

        $this->assertDatabaseHas('users', ['id' => $user->id]);
    }

    public function test_a_live_token_alone_is_not_enough(): void
    {
        [$user, $token] = $this->signedInUser();

        // No password in the body at all. The bearer token is valid, and that
        // is deliberately not sufficient: whoever is holding an open session is
        // not necessarily whoever owns the account.
        $this->actingAsToken($token)
            ->deleteJson('/api/v1/account', [])
            ->assertStatus(422);

        $this->assertDatabaseHas('users', ['id' => $user->id]);
    }

    public function test_deleting_takes_the_collection_and_the_tokens_with_it(): void
    {
        [$user, $token] = $this->signedInUser();
        $deck = $this->deckFor($user);
        $this->reviewFor($user, $deck->id.':0');

        $this->actingAsToken($token)
            ->deleteJson('/api/v1/account', ['password' => self::PASSWORD])
            ->assertOk()
            ->assertJsonPath('data.deleted', true);

        $this->assertDatabaseMissing('users', ['id' => $user->id]);
        $this->assertDatabaseMissing('decks', ['id' => $deck->id]);
        $this->assertDatabaseMissing('reviews', ['user_id' => $user->id]);
        $this->assertDatabaseMissing('devices', ['user_id' => $user->id]);
        $this->assertDatabaseMissing('personal_access_tokens', ['tokenable_id' => $user->id]);
    }

    public function test_one_account_going_leaves_another_untouched(): void
    {
        [$mine, $myToken] = $this->signedInUser('mine@example.test');
        [$theirs] = $this->signedInUser('theirs@example.test');
        $theirDeck = $this->deckFor($theirs);

        $this->actingAsToken($myToken)
            ->deleteJson('/api/v1/account', ['password' => self::PASSWORD])
            ->assertOk();

        $this->assertDatabaseMissing('users', ['id' => $mine->id]);
        $this->assertDatabaseHas('users', ['id' => $theirs->id]);
        $this->assertDatabaseHas('decks', ['id' => $theirDeck->id]);
    }

    public function test_the_token_stops_working_immediately(): void
    {
        [, $token] = $this->signedInUser();

        $this->actingAsToken($token)
            ->deleteJson('/api/v1/account', ['password' => self::PASSWORD])
            ->assertOk();

        $this->actingAsToken($token)
            ->getJson('/api/v1/auth/me')
            ->assertStatus(401);
    }
}
