<?php

declare(strict_types=1);

namespace Tests\Feature\Collaboration;

use App\Models\Deck;
use App\Models\DeckCollaborator;
use App\Models\User;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * Shared setup for the live-collaboration tests: an owner, a deck, and people
 * at each of the three roles.
 */
abstract class CollaborationTestCase extends TestCase
{
    use RefreshDatabase;

    protected const PASSWORD = 'thoracic-aorta-lecture-notes';

    /**
     * Drop the bearer token from the next request — see the marketplace test
     * case for why `flushHeaders()` alone is not enough.
     */
    protected function anonymous(): static
    {
        Auth::forgetGuards();

        return $this->flushHeaders();
    }

    protected function account(?string $email = null): User
    {
        return User::factory()->create([
            'password' => self::PASSWORD,
            ...($email !== null ? ['email' => $email] : []),
        ]);
    }

    protected function tokenFor(User $user): string
    {
        return app(AuthService::class)
            ->login($user->email, self::PASSWORD, new DeviceIdentity('iPhone'))['token']
            ->plainTextToken;
    }

    protected function deckOwnedBy(User $owner, string $name = 'Anatomy'): Deck
    {
        return Deck::query()->create([
            'id' => (string) Str::uuid(),
            'user_id' => $owner->id,
            'name' => $name,
            'revision' => 1,
            'client_updated_at' => 1_700_000_000_000,
        ]);
    }

    /** An accepted collaborator at the given role — the state most tests want. */
    protected function collaborator(Deck $deck, User $user, string $role): DeckCollaborator
    {
        return DeckCollaborator::query()->create([
            'deck_id' => $deck->id,
            'user_id' => $user->id,
            'invited_email' => $user->email,
            'role' => $role,
            'invited_by' => $deck->user_id,
            'accepted_at' => now(),
        ]);
    }

    /** Base64, because every payload on the wire is and the server checks it. */
    protected function update(string $text = 'an edit'): string
    {
        return base64_encode($text);
    }
}
