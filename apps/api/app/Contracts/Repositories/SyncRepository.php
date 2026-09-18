<?php

namespace App\Contracts\Repositories;

use App\Enums\SyncResource;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Collection;

/**
 * The read and write half of sync, kept behind an interface because it is the
 * one place a change of storage is actually plausible: the pull is six indexed
 * range scans that a read replica or a cache could serve, and the services above
 * should not have to know which.
 */
interface SyncRepository
{
    /**
     * Rows above the cursor, oldest change first.
     *
     * @return Collection<int, Model>
     */
    public function changedSince(User $user, SyncResource $resource, int $cursor, int $limit): Collection;

    /**
     * Which of these keys this account already has.
     *
     * @param  list<string>  $keys
     * @return array<string, Model>
     */
    public function existing(User $user, SyncResource $resource, array $keys): array;

    /**
     * @param  list<array<string, mixed>>  $rows
     */
    public function insertMany(User $user, SyncResource $resource, array $rows): int;

    /**
     * @param  array<string, array<string, mixed>>  $rows  keyed by the resource's key
     */
    public function upsertMany(User $user, SyncResource $resource, array $rows): int;
}
