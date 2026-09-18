<?php

namespace App\Contracts\Repositories;

use App\Models\User;

/**
 * Data access for accounts.
 *
 * The interface exists so the services above it name *what* they need rather
 * than how Eloquent spells it — and so a test can hand them a fake without a
 * database. The Eloquent implementation is the only one today; that is fine,
 * the value is the seam, not the count.
 */
interface UserRepository
{
    public function findByEmail(string $email): ?User;

    public function create(string $name, string $email, string $password): User;

    /**
     * Reserve a block of sync revisions and return the first in it.
     *
     * Every syncable row is stamped with a value from this counter, and a device
     * pulls everything above its cursor. The numbers must be unique and must
     * never be committed below a revision a device has already pulled past, so
     * this locks rather than reading-then-writing.
     */
    public function allocateRevisions(User $user, int $count = 1): int;
}
