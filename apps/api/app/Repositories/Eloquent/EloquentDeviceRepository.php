<?php

namespace App\Repositories\Eloquent;

use App\Contracts\Repositories\DeviceRepository;
use App\Models\Device;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

final class EloquentDeviceRepository implements DeviceRepository
{
    public function findForUser(User $user, string $deviceId): ?Device
    {
        return $user->devices()->with('token')->find($deviceId);
    }

    /** @return Collection<int, Device> */
    public function listForUser(User $user): Collection
    {
        return $user->devices()->orderByDesc('last_seen_at')->get();
    }

    public function registerSignIn(User $user, ?string $deviceId, string $name, ?string $platform, string $tokenId): Device
    {
        $device = $deviceId ? $this->findForUser($user, $deviceId) : null;

        if (! $device) {
            return Device::create([
                'id' => $deviceId,
                'user_id' => $user->id,
                'name' => $name,
                'platform' => $platform,
                'token_id' => $tokenId,
                'cursor' => 0,
                'last_seen_at' => Carbon::now(),
            ]);
        }

        // The previous token goes, so a laptop left behind stops syncing; the
        // cursor stays, which is the whole reason the row outlives the token.
        $device->token?->delete();
        $device->update([
            'name' => $name,
            'platform' => $platform,
            'token_id' => $tokenId,
            'last_seen_at' => Carbon::now(),
        ]);

        return $device->refresh();
    }

    public function detachToken(User $user, string $tokenId): void
    {
        $user->devices()->where('token_id', $tokenId)->update(['token_id' => null]);
    }

    public function forget(Device $device): void
    {
        $device->token?->delete();
        $device->delete();
    }

    public function advanceCursor(User $user, string $tokenId, int $cursor): void
    {
        $user->devices()
            ->where('token_id', $tokenId)
            ->where('cursor', '<', $cursor)
            ->update(['cursor' => $cursor, 'last_seen_at' => Carbon::now()]);
    }
}
