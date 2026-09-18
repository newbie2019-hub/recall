<?php

namespace App\Repositories\Eloquent;

use App\Contracts\Repositories\UserRepository;
use App\Models\User;
use Illuminate\Support\Facades\DB;

final class EloquentUserRepository implements UserRepository
{
    public function findByEmail(string $email): ?User
    {
        return User::query()->where('email', $email)->first();
    }

    public function create(string $name, string $email, string $password): User
    {
        return User::create([
            'name' => $name,
            'email' => $email,
            'password' => $password,
        ]);
    }

    /**
     * The row lock is the point.
     *
     * An `UPDATE … SET sync_revision = sync_revision + 1` followed by a read
     * lets two pushes landing together read the same value back and stamp two
     * different rows with it — and the second row is then invisible to every
     * device that has already pulled past the first.
     *
     * Blocks, because a push writes many rows: one lock for 500 notes, not 500.
     */
    public function allocateRevisions(User $user, int $count = 1): int
    {
        return DB::transaction(function () use ($user, $count): int {
            $current = (int) User::query()
                ->whereKey($user->getKey())
                ->lockForUpdate()
                ->value('sync_revision');

            User::query()->whereKey($user->getKey())->update(['sync_revision' => $current + $count]);
            $user->sync_revision = $current + $count;

            return $current + 1;
        });
    }
}
