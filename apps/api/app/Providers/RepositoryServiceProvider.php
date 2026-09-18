<?php

namespace App\Providers;

use App\Contracts\Repositories\DeviceRepository;
use App\Contracts\Repositories\ListingRepository;
use App\Contracts\Repositories\SyncRepository;
use App\Contracts\Repositories\UserRepository;
use App\Repositories\Eloquent\EloquentDeviceRepository;
use App\Repositories\Eloquent\EloquentListingRepository;
use App\Repositories\Eloquent\EloquentSyncRepository;
use App\Repositories\Eloquent\EloquentUserRepository;
use Illuminate\Support\ServiceProvider;

/**
 * The one place that decides which storage the services talk to.
 *
 * Singletons because the repositories are stateless: they hold a query builder's
 * worth of knowledge and nothing per-request.
 */
class RepositoryServiceProvider extends ServiceProvider
{
    /** @var array<class-string, class-string> */
    public array $bindings = [
        UserRepository::class => EloquentUserRepository::class,
        DeviceRepository::class => EloquentDeviceRepository::class,
        ListingRepository::class => EloquentListingRepository::class,
        SyncRepository::class => EloquentSyncRepository::class,
    ];
}
