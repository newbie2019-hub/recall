<?php

namespace Tests\Feature;

use App\Models\Device;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Keys are uuids everywhere, including the two Laravel and Sanctum would
 * otherwise make integers.
 */
class UuidKeysTest extends TestCase
{
    use RefreshDatabase;

    public function test_users_devices_and_tokens_all_get_uuid_keys(): void
    {
        $user = User::factory()->create();
        $this->assertTrue(Str::isUuid($user->id), 'user id');

        $device = Device::create([
            'user_id' => $user->id,
            'name' => "Yvan's iPhone",
            'platform' => 'ios',
        ]);
        $this->assertTrue(Str::isUuid($device->id), 'device id');

        // Sanctum's own model assumes an auto-incrementing id; the override in
        // AppServiceProvider is what makes this pass.
        $token = $user->createToken("Yvan's iPhone");
        $this->assertTrue(Str::isUuid($token->accessToken->id), 'token id');

        // The plain-text token is `<id>|<secret>`, so the uuid travels with it —
        // which is the point: an integer there is a running count of every token
        // the service has ever issued.
        $this->assertSame($token->accessToken->id, Str::before($token->plainTextToken, '|'));

        // And the token resolves back, which is what every authenticated request
        // actually depends on.
        $this->assertTrue($user->is(
            Sanctum::personalAccessTokenModel()::findToken($token->plainTextToken)?->tokenable
        ));

        $device->update(['token_id' => $token->accessToken->id]);
        $this->assertSame($token->accessToken->id, $device->fresh()->token_id);
    }
}
