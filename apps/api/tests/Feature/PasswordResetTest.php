<?php

namespace Tests\Feature;

use App\Models\User;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Notification;
use Tests\TestCase;

class PasswordResetTest extends TestCase
{
    use RefreshDatabase;

    private const OLD = 'thoracic-aorta-lecture-notes';

    private const NEW = 'circle-of-willis-diagram';

    public function test_the_link_lands_on_the_web_apps_reset_path(): void
    {
        Notification::fake();
        config(['app.frontend_url' => 'https://recall.test']);
        $user = User::factory()->create(['email' => 'yvan@example.test', 'password' => self::OLD]);

        $this->postJson('/api/v1/auth/forgot-password', ['email' => 'yvan@example.test'])
            ->assertOk()
            ->assertJsonPath('data.sent', true);

        Notification::assertSentTo($user, ResetPassword::class, function (ResetPassword $mail) use ($user): bool {
            // The link opens the SPA, not the API. A `password.reset` web route
            // does not exist here, so Laravel's stock URL would 404 in a mail
            // client — the failure nobody sees until a real user reports it.
            $this->assertSame(
                'https://recall.test/reset/'.$mail->token.'?email=yvan%40example.test',
                $mail->toMail($user)->actionUrl,
            );

            return true;
        });
    }

    public function test_an_unknown_address_is_answered_exactly_like_a_known_one(): void
    {
        Notification::fake();
        User::factory()->create(['email' => 'yvan@example.test', 'password' => self::OLD]);

        $known = $this->postJson('/api/v1/auth/forgot-password', ['email' => 'yvan@example.test']);
        $unknown = $this->postJson('/api/v1/auth/forgot-password', ['email' => 'nobody@example.test']);

        $known->assertOk();
        $unknown->assertOk();
        // Same body and same status, or this endpoint is an address oracle.
        $this->assertSame($known->json('data'), $unknown->json('data'));
        Notification::assertSentTimes(ResetPassword::class, 1);
    }

    public function test_resetting_changes_the_password_and_signs_every_device_out_without_losing_its_cursor(): void
    {
        $user = User::factory()->create(['email' => 'yvan@example.test', 'password' => self::OLD]);
        $session = app(AuthService::class)->login($user->email, self::OLD, new DeviceIdentity('iPhone'));
        $session['device']->update(['cursor' => 4_812]);

        $this->postJson('/api/v1/auth/reset-password', [
            'token' => $this->tokenFor($user),
            'email' => 'yvan@example.test',
            'password' => self::NEW,
        ])->assertOk()->assertJsonPath('data.reset', true);

        $this->assertTrue(Hash::check(self::NEW, $user->fresh()->password));
        // Whoever had the old password is out.
        $this->assertSame(0, $user->tokens()->count());
        $this->actingAsToken($session['token']->plainTextToken)
            ->getJson('/api/v1/auth/me')->assertStatus(401);

        // Sign-out, not revoke: the row and its cursor outlive the token, so
        // the phone resumes instead of re-pulling the whole collection.
        $device = $user->devices()->find($session['device']->id);
        $this->assertNotNull($device);
        $this->assertSame(4_812, $device->cursor);
        $this->assertNull($device->token_id);

        $this->postJson('/api/v1/auth/login', [
            'email' => 'yvan@example.test', 'password' => self::NEW, 'device_name' => 'iPhone',
        ])->assertOk();
    }

    public function test_a_stale_token_fails_on_the_form_and_leaves_the_old_password_working(): void
    {
        $user = User::factory()->create(['email' => 'yvan@example.test', 'password' => self::OLD]);
        $token = $this->tokenFor($user);

        // Used once…
        $this->postJson('/api/v1/auth/reset-password', [
            'token' => $token, 'email' => 'yvan@example.test', 'password' => self::NEW,
        ])->assertOk();

        // …is used up. The client shows this on the field; it never redirects.
        $this->postJson('/api/v1/auth/reset-password', [
            'token' => $token, 'email' => 'yvan@example.test', 'password' => 'a-third-password',
        ])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');

        $this->assertTrue(Hash::check(self::NEW, $user->fresh()->password));
    }

    public function test_a_weak_new_password_is_refused_by_the_same_policy_as_sign_up(): void
    {
        $user = User::factory()->create(['email' => 'yvan@example.test', 'password' => self::OLD]);

        $this->postJson('/api/v1/auth/reset-password', [
            'token' => $this->tokenFor($user), 'email' => 'yvan@example.test', 'password' => 'short',
        ])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');

        $this->assertTrue(Hash::check(self::OLD, $user->fresh()->password));
    }

    /** The plain token, which only ever exists in the mail the broker sends. */
    private function tokenFor(User $user): string
    {
        $token = '';
        Notification::fake();
        $this->postJson('/api/v1/auth/forgot-password', ['email' => $user->email])->assertOk();
        Notification::assertSentTo($user, ResetPassword::class, function (ResetPassword $mail) use (&$token): bool {
            $token = $mail->token;

            return true;
        });

        return $token;
    }
}
