<?php

namespace App\Repositories\Eloquent;

use App\Contracts\Repositories\SyncRepository;
use App\Enums\SyncResource;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

final class EloquentSyncRepository implements SyncRepository
{
    /** @return Collection<int, Model> */
    public function changedSince(User $user, SyncResource $resource, int $cursor, int $limit): Collection
    {
        $model = $resource->model();

        return $model::query()
            ->ownedBy($user)
            ->changedSince($cursor)
            // One more than the page, so the caller can tell "this is the last
            // page" from "there is exactly one more row" without a second query.
            ->limit($limit + 1)
            ->get();
    }

    /** @return array<string, Model> */
    public function existing(User $user, SyncResource $resource, array $keys): array
    {
        if ($keys === []) {
            return [];
        }

        $model = $resource->model();

        return $model::query()
            ->ownedBy($user)
            ->whereIn($resource->key(), $keys)
            ->get()
            ->keyBy($resource->key())
            ->all();
    }

    public function insertMany(User $user, SyncResource $resource, array $rows): int
    {
        if ($rows === []) {
            return 0;
        }

        $model = $resource->model();
        $model::query()->insert($rows);

        return count($rows);
    }

    public function upsertMany(User $user, SyncResource $resource, array $rows): int
    {
        $model = $resource->model();
        $key = $resource->key();

        foreach ($rows as $id => $attributes) {
            $model::query()->updateOrCreate(
                ['user_id' => $user->id, $key => $id],
                $attributes,
            );
        }

        return count($rows);
    }

    public function now(): Carbon
    {
        return Carbon::now();
    }
}
