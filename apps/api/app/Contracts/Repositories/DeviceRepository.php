<?php

namespace App\Contracts\Repositories;

use App\Models\Device;
use App\Models\User;
use Illuminate\Support\Collection;

interface DeviceRepository
{
    public function findForUser(User $user, string $deviceId): ?Device;

    /** @return Collection<int, Device> */
    public function listForUser(User $user): Collection;

    /**
     * Attach a freshly issued token to a device, creating the row if this is the
     * first time we have seen it.
     *
     * A device signing in again keeps its row — and therefore its cursor — so it
     * resumes instead of re-pulling a collection it already holds.
     */
    public function registerSignIn(User $user, ?string $deviceId, string $name, ?string $platform, string $tokenId): Device;

    /** Sign out: the token goes, the row and its cursor stay. */
    public function detachToken(User $user, string $tokenId): void;

    /** Revoke: the person said this phone is not theirs any more, so both go. */
    public function forget(Device $device): void;

    /** Only ever moves forward — re-requesting an older page must not rewind it. */
    public function advanceCursor(User $user, string $tokenId, int $cursor): void;
}
