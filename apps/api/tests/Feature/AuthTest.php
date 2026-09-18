<?php

namespace Tests\Feature;

use App\Models\Device;
use App\Models\User;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    private array $device = [
        'device_name' => "Yvan's iPhone",
        'platform' => 'ios',
    ];

    public function test_registering_returns_a_token_a_device_and_no_verification_wall(): void
    {
        $response = $this->postJson('/api/v1/auth/register', [
            'name' => 'Yvan',
            'email' => 'yvan@example.test',
            'password' => self::PASSWORD,
            ...$this->device,
        ]);

        $response->assertCreated()
            ->assertJsonPath('data.user.email', 'yvan@example.test')
            ->assertJsonPath('data.device.name', "Yvan's iPhone")
            ->assertJsonPath('data.device.cursor', 0)
            // Verification gates publishing to the marketplace, not studying.
            ->assertJsonPath('data.user.email_verified', false)
            ->assertJsonStructure(['data' => ['token', 'expires_at'], 'server_time']);

        // Rounded: the column stores whole seconds, so an exact 60-day span
        // comes back a hair under and truncates to 59.
        $this->assertSame(60, (int) round(Carbon::now()->diffInDays(
            Carbon::parse($response->json('data.expires_at')), absolute: true
        )));
    }

    public function test_a_weak_or_duplicate_signup_fails_with_a_stable_code(): void
    {
        User::factory()->create(['email' => 'taken@example.test', 'password' => self::PASSWORD]);

        $this->postJson('/api/v1/auth/register', [
            'name' => 'Yvan', 'email' => 'taken@example.test',
            'password' => self::PASSWORD, ...$this->device,
        ])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');

        // Too short. The breach-corpus check is production-only (see
        // AppServiceProvider) so that this suite does not need the network.
        $this->postJson('/api/v1/auth/register', [
            'name' => 'Yvan', 'email' => 'new@example.test',
            'password' => 'short', ...$this->device,
        ])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_a_wrong_password_and_an_unknown_account_are_indistinguishable(): void
    {
        User::factory()->create(['email' => 'yvan@example.test', 'password' => self::PASSWORD]);

        $wrong = $this->postJson('/api/v1/auth/login', [
            'email' => 'yvan@example.test', 'password' => 'nope', ...$this->device,
        ]);
        $missing = $this->postJson('/api/v1/auth/login', [
            'email' => 'nobody@example.test', 'password' => 'nope', ...$this->device,
        ]);

        $wrong->assertStatus(401)->assertJsonPath('error.code', 'invalid_credentials');
        // Same body, or the endpoint becomes a way to discover which addresses
        // have accounts here.
        $this->assertSame($wrong->json('error'), $missing->json('error'));
    }

    public function test_signing_in_again_from_the_same_device_keeps_its_cursor(): void
    {
        $user = User::factory()->create(['password' => self::PASSWORD]);
        $first = $this->postJson('/api/v1/auth/login', [
            'email' => $user->email, 'password' => self::PASSWORD, ...$this->device,
        ])->assertOk();

        $deviceId = $first->json('data.device.id');
        Device::find($deviceId)->update(['cursor' => 4_812]);

        $second = $this->postJson('/api/v1/auth/login', [
            'email' => $user->email, 'password' => 'thoracic-aorta-lecture-notes',
            'device_id' => $deviceId, ...$this->device,
        ])->assertOk();

        $this->assertSame($deviceId, $second->json('data.device.id'), 'same device row');
        $this->assertSame(4_812, $second->json('data.device.cursor'), 'the cursor survived');
        $this->assertNotSame($first->json('data.token'), $second->json('data.token'));
        $this->assertCount(1, $user->devices()->get(), 'one phone, one row');
        // The old token is gone, so a stolen laptop cannot keep syncing.
        $this->assertSame(1, $user->tokens()->count());
    }

    public function test_an_expired_token_is_rejected_with_its_own_code(): void
    {
        $user = User::factory()->create(['password' => self::PASSWORD]);
        $token = $user->createToken('old', ['*'], Carbon::now()->subDay());

        $this->actingAsToken($token->plainTextToken)
            ->getJson('/api/v1/auth/me')
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'unauthenticated');
    }

    public function test_an_active_token_has_its_expiry_pushed_out(): void
    {
        $user = User::factory()->create(['password' => self::PASSWORD]);
        $issued = app(AuthService::class)->login($user->email, self::PASSWORD, new DeviceIdentity('iPhone'));
        $token = $issued['token'];

        // A fortnight offline, then one request.
        Carbon::setTestNow(Carbon::now()->addDays(14));
        $this->actingAsToken($token->plainTextToken)
            ->getJson('/api/v1/auth/me')->assertOk();

        $this->assertSame(60, (int) round(Carbon::now()->diffInDays(
            $token->accessToken->fresh()->expires_at, absolute: true
        )), 'the window slid forward from today, not from when it was issued');
        Carbon::setTestNow();
    }

    public function test_signing_out_keeps_the_device_row_but_revoking_removes_it(): void
    {
        $user = User::factory()->create(['password' => self::PASSWORD]);
        $issued = app(AuthService::class)->login($user->email, self::PASSWORD, new DeviceIdentity('iPhone'));

        $this->actingAsToken($issued['token']->plainTextToken)->postJson('/api/v1/auth/logout')->assertOk();
        // The row survives, carrying its cursor, so signing back in resumes.
        $this->assertNotNull($user->devices()->find($issued['device']->id));
        $this->assertSame(0, $user->tokens()->count());

        $second = app(AuthService::class)->login($user->email, self::PASSWORD, new DeviceIdentity('iPad'));
        $this->actingAsToken($second['token']->plainTextToken)
            ->deleteJson('/api/v1/devices/'.$second['device']->id)
            ->assertOk();
        $this->assertNull($user->devices()->find($second['device']->id), 'revoking forgets the device');
    }

    public function test_devices_are_scoped_to_their_owner(): void
    {
        $mine = User::factory()->create(['password' => self::PASSWORD]);
        $theirs = User::factory()->create(['password' => self::PASSWORD]);
        $ours = app(AuthService::class)->login($mine->email, self::PASSWORD, new DeviceIdentity('iPhone'));
        $other = app(AuthService::class)->login($theirs->email, self::PASSWORD, new DeviceIdentity('Their laptop'));

        $this->actingAsToken($ours['token']->plainTextToken)
            ->getJson('/api/v1/devices')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.current', true);

        // Somebody else's device id must not be revocable, and must not even
        // confirm that it exists.
        $this->actingAsToken($ours['token']->plainTextToken)
            ->deleteJson('/api/v1/devices/'.$other['device']->id)
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'not_found');
        $this->assertNotNull(Device::find($other['device']->id));
    }

    public function test_unauthenticated_requests_get_the_stable_error_shape(): void
    {
        $this->getJson('/api/v1/auth/me')
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'unauthenticated')
            ->assertJsonStructure(['error' => ['code', 'message'], 'server_time']);

        $this->assertTrue(Str::isUuid(
            User::factory()->create()->createToken('x')->accessToken->id
        ));
    }
}
