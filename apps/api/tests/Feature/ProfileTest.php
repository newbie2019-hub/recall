<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\User;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Changing your own account.
 *
 * The two rules worth a test are the ones a careless implementation gets
 * backwards: a new address must lose its verification, and a password change
 * must prove the old password even though the request is already authenticated.
 */
class ProfileTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    public function test_it_updates_the_name_and_avatar(): void
    {
        $user = $this->account();

        $this->actingAsToken($this->tokenFor($user))
            ->patchJson(route('auth.profile'), ['name' => 'Y. Sabay', 'avatar' => 'fox'])
            ->assertOk()
            ->assertJsonPath('data.name', 'Y. Sabay')
            ->assertJsonPath('data.avatar', 'fox');
    }

    public function test_changing_the_address_un_verifies_it(): void
    {
        // The old confirmation was proof about a different mailbox, so anything
        // gated on verification must close until the new one is confirmed.
        $user = $this->account();
        $this->assertTrue($user->email_verified_at !== null);

        $this->actingAsToken($this->tokenFor($user))
            ->patchJson(route('auth.profile'), ['email' => 'new@example.test'])
            ->assertOk()
            ->assertJsonPath('data.email', 'new@example.test')
            ->assertJsonPath('data.email_verified', false);
    }

    public function test_keeping_the_same_address_keeps_the_verification(): void
    {
        $user = $this->account();

        $this->actingAsToken($this->tokenFor($user))
            ->patchJson(route('auth.profile'), ['email' => $user->email, 'name' => 'Same Address'])
            ->assertOk()
            ->assertJsonPath('data.email_verified', true);
    }

    public function test_an_address_already_taken_is_refused(): void
    {
        $taken = $this->account();
        $mine = $this->account();

        $this->actingAsToken($this->tokenFor($mine))
            ->patchJson(route('auth.profile'), ['email' => $taken->email])
            ->assertStatus(422);
    }

    public function test_an_avatar_key_cannot_carry_a_url_or_markup(): void
    {
        $this->actingAsToken($this->tokenFor($this->account()))
            ->patchJson(route('auth.profile'), ['avatar' => 'https://evil.test/x.svg'])
            ->assertStatus(422);
    }

    public function test_the_password_change_proves_the_old_one(): void
    {
        $user = $this->account();

        $this->actingAsToken($this->tokenFor($user))
            ->putJson(route('auth.password'), [
                'current_password' => 'not-it',
                'password' => 'a-brand-new-passphrase',
                'password_confirmation' => 'a-brand-new-passphrase',
            ])
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'invalid_credentials');

        $this->assertTrue(Hash::check(self::PASSWORD, $user->fresh()->password), 'unchanged');
    }

    public function test_the_password_changes_when_the_old_one_is_right(): void
    {
        $user = $this->account();

        $this->actingAsToken($this->tokenFor($user))
            ->putJson(route('auth.password'), [
                'current_password' => self::PASSWORD,
                'password' => 'a-brand-new-passphrase',
                'password_confirmation' => 'a-brand-new-passphrase',
            ])
            ->assertOk();

        $this->assertTrue(Hash::check('a-brand-new-passphrase', $user->fresh()->password));
    }

    public function test_both_endpoints_are_closed_to_strangers(): void
    {
        $this->patchJson(route('auth.profile'), ['name' => 'Nobody'])->assertStatus(401);
        $this->putJson(route('auth.password'), [])->assertStatus(401);
    }

    private function account(): User
    {
        return User::factory()->create(['password' => self::PASSWORD]);
    }

    private function tokenFor(User $user): string
    {
        return app(AuthService::class)
            ->login($user->email, self::PASSWORD, new DeviceIdentity('iPhone'))['token']
            ->plainTextToken;
    }
}
