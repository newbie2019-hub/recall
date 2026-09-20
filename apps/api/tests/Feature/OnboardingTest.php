<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\User;
use App\Models\UserProfile;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * The welcome wizard's endpoint.
 *
 * Two things are worth a test here and the rest is validation boilerplate:
 * **the enumerated columns cannot be filled with free text**, because they are
 * what a marketing question groups by and one bad write poisons them for good;
 * and **submitting twice updates one row**, because the wizard's last screen is
 * exactly the kind of thing people reload.
 */
class OnboardingTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    public function test_it_stores_the_answers_and_marks_the_account_onboarded(): void
    {
        $user = $this->account();

        $this->actingAsToken($this->tokenFor($user))
            ->putJson(route('onboarding.update'), $this->answers())
            ->assertOk()
            ->assertJsonPath('data.onboarded', true);

        $profile = UserProfile::query()->where('user_id', $user->id)->firstOrFail();

        $this->assertSame('student', $profile->role);
        $this->assertSame('medicine', $profile->subject);
        $this->assertSame(['pass_exam', 'coursework'], $profile->goals);
        $this->assertSame(30, $profile->daily_minutes);
        $this->assertNotNull($profile->completed_at);
    }

    public function test_the_session_reports_onboarding_only_once_it_is_finished(): void
    {
        $user = $this->account();
        $token = $this->tokenFor($user);

        $this->actingAsToken($token)
            ->getJson(route('auth.me'))
            ->assertOk()
            ->assertJsonPath('data.onboarded', false);

        $this->actingAsToken($token)->putJson(route('onboarding.update'), $this->answers());

        $this->actingAsToken($token)
            ->getJson(route('auth.me'))
            ->assertOk()
            ->assertJsonPath('data.onboarded', true);
    }

    public function test_submitting_twice_updates_one_row_instead_of_adding_a_second(): void
    {
        $user = $this->account();
        $token = $this->tokenFor($user);

        $this->actingAsToken($token)->putJson(route('onboarding.update'), $this->answers())->assertOk();
        $this->actingAsToken($token)
            ->putJson(route('onboarding.update'), $this->answers(['subject' => 'law', 'daily_minutes' => 60]))
            ->assertOk();

        $this->assertSame(1, UserProfile::query()->where('user_id', $user->id)->count());
        $this->assertSame('law', UserProfile::query()->where('user_id', $user->id)->value('subject'));
    }

    public function test_an_enumerated_column_rejects_anything_not_on_the_list(): void
    {
        $token = $this->tokenFor($this->account());

        $this->actingAsToken($token)
            ->putJson(route('onboarding.update'), $this->answers(['heard_from' => 'a billboard']))
            ->assertStatus(422);

        $this->actingAsToken($token)
            ->putJson(route('onboarding.update'), $this->answers(['goals' => ['pass_exam', 'vibes']]))
            ->assertStatus(422);
    }

    public function test_choosing_other_makes_its_free_text_required(): void
    {
        $token = $this->tokenFor($this->account());

        $this->actingAsToken($token)
            ->putJson(route('onboarding.update'), $this->answers(['heard_from' => 'other']))
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');

        $this->actingAsToken($token)
            ->putJson(route('onboarding.update'), $this->answers([
                'heard_from' => 'other',
                'heard_from_other' => 'a poster in the anatomy lab',
            ]))
            ->assertOk();
    }

    public function test_free_text_is_dropped_when_its_choice_was_not_other(): void
    {
        // Somebody types into the box, changes their mind, and picks a real
        // category. The stray sentence must not survive attached to it.
        $user = $this->account();

        $this->actingAsToken($this->tokenFor($user))
            ->putJson(route('onboarding.update'), $this->answers([
                'subject' => 'medicine',
                'subject_other' => 'underwater basket weaving',
            ]))
            ->assertOk();

        $this->assertNull(UserProfile::query()->where('user_id', $user->id)->value('subject_other'));
    }

    public function test_a_referral_code_is_stored_upper_case_and_trimmed(): void
    {
        $user = $this->account();

        $this->actingAsToken($this->tokenFor($user))
            ->putJson(route('onboarding.update'), $this->answers(['referral_code' => '  spring26 ']))
            ->assertOk();

        $this->assertSame('SPRING26', UserProfile::query()->where('user_id', $user->id)->value('referral_code'));
    }

    public function test_it_is_closed_to_strangers(): void
    {
        $this->putJson(route('onboarding.update'), $this->answers())->assertStatus(401);
    }

    /**
     * @param  array<string, mixed>  $overrides
     * @return array<string, mixed>
     */
    private function answers(array $overrides = []): array
    {
        return [
            'role' => 'student',
            'country' => 'AU',
            'subject' => 'medicine',
            'level' => 'undergraduate',
            'goals' => ['pass_exam', 'coursework'],
            'daily_minutes' => 30,
            'exam_date' => '2026-11-02',
            'heard_from' => 'reddit',
            'referral_code' => null,
            ...$overrides,
        ];
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
