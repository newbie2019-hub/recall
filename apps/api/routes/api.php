<?php

use App\Http\Controllers\Api\V1\AccountController;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\DeviceController;
use App\Http\Controllers\Api\V1\ImportController;
use App\Http\Controllers\Api\V1\ListingController;
use App\Http\Controllers\Api\V1\ModerationController;
use App\Http\Controllers\Api\V1\PasswordResetController;
use App\Http\Controllers\Api\V1\SyncController;
use App\Models\Listing;
use Illuminate\Support\Facades\Route;

/*
 * API v1. Mounted at /api/v1 by bootstrap/app.php.
 *
 * Bearer tokens only — no CSRF, no session state — because that is the only
 * scheme React Native can speak without a cookie jar, and running cookie auth on
 * web plus tokens on mobile means two auth paths and two refresh bugs
 * (PLAN.md §2.6).
 */

Route::post('auth/register', [AuthController::class, 'register'])
    ->middleware('throttle:10,1')
    ->name('auth.register');

Route::post('auth/login', [AuthController::class, 'login'])
    ->middleware('throttle:10,1')
    ->name('auth.login');

// Both are reached by somebody who cannot sign in, so both sit outside the
// guard. Tighter throttles than login: these two send mail and are the pair an
// attacker would use to enumerate addresses or grind a token.
Route::post('auth/forgot-password', [PasswordResetController::class, 'send'])
    ->middleware('throttle:5,1')
    ->name('auth.forgot-password');

Route::post('auth/reset-password', [PasswordResetController::class, 'reset'])
    ->middleware('throttle:5,1')
    ->name('auth.reset-password');

Route::middleware('auth:sanctum')->group(function (): void {
    Route::post('auth/logout', [AuthController::class, 'logout'])->name('auth.logout');
    Route::get('auth/me', [AuthController::class, 'me'])->name('auth.me');

    // Deleting the account asks for the password again, so it is throttled
    // like a credential endpoint rather than like a normal authenticated call.
    Route::delete('account', [AccountController::class, 'destroy'])
        ->middleware('throttle:5,1')
        ->name('account.destroy');

    Route::get('devices', [DeviceController::class, 'index'])->name('devices.index');
    Route::delete('devices/{device}', [DeviceController::class, 'destroy'])->name('devices.destroy');

    Route::get('sync', [SyncController::class, 'pull'])->name('sync.pull');
    Route::post('sync', [SyncController::class, 'push'])->name('sync.push');

    // Upload once, poll until it is done. The throttle is on the upload only:
    // polling is the client's normal state and must not be rate-limited into
    // looking like a failure.
    Route::post('imports', [ImportController::class, 'store'])
        ->middleware('throttle:10,1')
        ->name('imports.store');
    Route::get('imports/{importJob}', [ImportController::class, 'show'])->name('imports.show');

    /*
     * Marketplace, the half that writes. Publishing additionally requires a
     * verified email address (ListingPolicy::publish) — nothing publishes
     * anonymously, because a takedown notice has to reach somebody.
     *
     * The two throttles are not decoration. Five publishes an hour is what stops
     * a script filling the catalogue; five reports an hour is what stops the
     * queue being used as a way to bury one person's deck.
     */
    Route::get('marketplace/my-listings', [ListingController::class, 'mine'])
        ->name('marketplace.listings.mine');

    Route::post('marketplace/listings', [ListingController::class, 'store'])
        ->middleware('throttle:5,60')
        ->name('marketplace.listings.store');

    Route::delete('marketplace/listings/{listing}', [ListingController::class, 'destroy'])
        ->name('marketplace.listings.destroy');

    Route::post('marketplace/listings/{listing}/installs', [ListingController::class, 'install'])
        ->middleware('throttle:60,1')
        ->name('marketplace.listings.install');

    Route::post('marketplace/listings/{listing}/reports', [ListingController::class, 'report'])
        ->middleware('throttle:5,60')
        ->name('marketplace.listings.report');

    Route::middleware('can:moderate,'.Listing::class)->group(function (): void {
        Route::get('moderation/reports', [ModerationController::class, 'index'])
            ->name('moderation.reports.index');

        Route::post('moderation/reports/{report}/dismiss', [ModerationController::class, 'dismiss'])
            ->name('moderation.reports.dismiss');

        Route::post('moderation/listings/{listing}/takedown', [ModerationController::class, 'takedown'])
            ->name('moderation.listings.takedown');

        Route::post('moderation/listings/{listing}/approve', [ModerationController::class, 'approve'])
            ->name('moderation.listings.approve');
    });
});

/*
 * Marketplace, the half that reads — deliberately outside `auth:sanctum`.
 *
 * A shared deck link has to open for somebody who does not have an account yet,
 * and Phase 12's universal links resolve to these same paths. All three pass
 * `Listing::scopeDistributable()`, so one takedown stops all three at once.
 */
Route::middleware('throttle:60,1')->group(function (): void {
    Route::get('marketplace/listings', [ListingController::class, 'index'])
        ->name('marketplace.listings.index');

    Route::get('marketplace/listings/{listing}', [ListingController::class, 'show'])
        ->name('marketplace.listings.show');

    Route::get('marketplace/listings/{listing}/versions/{version}', [ListingController::class, 'version'])
        ->whereNumber('version')
        ->name('marketplace.listings.version');
});
