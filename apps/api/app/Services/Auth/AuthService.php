<?php

namespace App\Services\Auth;

use App\Contracts\Repositories\DeviceRepository;
use App\Contracts\Repositories\UserRepository;
use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Models\Device;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\NewAccessToken;

/**
 * Accounts, tokens and devices.
 *
 * All of it sits behind one service because the three are a single decision in
 * this product: PLAN.md §2.6 keeps a token and a sync cursor on the same row, so
 * "sign in" is never just "issue a token" — it is also "which device is this,
 * and how much has it already seen".
 */
final readonly class AuthService
{
    /** Sixty days of no sync at all is when asking for a password is reasonable. */
    public const TOKEN_LIFETIME_DAYS = 60;

    public function __construct(
        private UserRepository $users,
        private DeviceRepository $devices,
    ) {}

    /**
     * Create an account. Deliberately does *not* verify email first — PLAN.md
     * §2.6 gates publishing to the marketplace, not studying.
     *
     * @return array{user: User, token: NewAccessToken, device: Device}
     */
    public function register(string $name, string $email, string $password, DeviceIdentity $device): array
    {
        return DB::transaction(function () use ($name, $email, $password, $device): array {
            $user = $this->users->create($name, $email, $password);

            return ['user' => $user, ...$this->issueToken($user, $device)];
        });
    }

    /**
     * @return array{user: User, token: NewAccessToken, device: Device}
     */
    public function login(string $email, string $password, DeviceIdentity $device): array
    {
        $user = $this->users->findByEmail($email);

        // One message for "no such account" and for "wrong password", or the
        // endpoint becomes a way to discover which addresses have accounts here.
        if (! $user || ! Hash::check($password, $user->password)) {
            throw new ApiException(
                ApiErrorCode::InvalidCredentials,
                'That email and password do not match.',
            );
        }

        return ['user' => $user, ...$this->issueToken($user, $device)];
    }

    /**
     * Sign out this device only: the token goes, the row and its cursor stay,
     * so signing back in resumes rather than re-pulling the collection.
     */
    public function logout(User $user, string $tokenId): void
    {
        $this->devices->detachToken($user, $tokenId);
        $user->tokens()->whereKey($tokenId)->delete();
    }

    public function revokeDevice(User $user, string $deviceId): void
    {
        $device = $this->devices->findForUser($user, $deviceId);

        // 404 rather than 403: confirming that somebody else's device id exists
        // is itself information.
        if (! $device) {
            throw new ApiException(ApiErrorCode::NotFound, 'No such device on this account.');
        }

        $this->devices->forget($device);
    }

    /**
     * @return array{token: NewAccessToken, device: Device}
     */
    private function issueToken(User $user, DeviceIdentity $identity): array
    {
        $token = $user->createToken(
            $identity->name,
            ['*'],
            Carbon::now()->addDays(self::TOKEN_LIFETIME_DAYS),
        );

        $device = $this->devices->registerSignIn(
            $user,
            $identity->id,
            $identity->name,
            $identity->platform,
            $token->accessToken->id,
        );

        return ['token' => $token, 'device' => $device];
    }
}
