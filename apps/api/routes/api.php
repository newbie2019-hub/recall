<?php

use App\Http\Controllers\Api\V1\AccountController;
use App\Http\Controllers\Api\V1\AiController;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\CollaborationController;
use App\Http\Controllers\Api\V1\DeviceController;
use App\Http\Controllers\Api\V1\DocumentController;
use App\Http\Controllers\Api\V1\ImportController;
use App\Http\Controllers\Api\V1\ListingController;
use App\Http\Controllers\Api\V1\MediaController;
use App\Http\Controllers\Api\V1\ModerationController;
use App\Http\Controllers\Api\V1\OnboardingController;
use App\Http\Controllers\Api\V1\PasswordResetController;
use App\Http\Controllers\Api\V1\ProfileController;
use App\Http\Controllers\Api\V1\SyncController;
use App\Models\Listing;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Broadcast;
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

    // The welcome wizard. An upsert, so a reload on the last screen is free;
    // throttled loosely because a wizard is submitted once and a retry is the
    // only realistic second call.
    // The account behind the session, as opposed to the session itself.
    Route::patch('auth/profile', [ProfileController::class, 'update'])
        ->middleware('throttle:20,1')
        ->name('auth.profile');
    // Throttled like a credential endpoint, because it is one.
    Route::put('auth/password', [ProfileController::class, 'password'])
        ->middleware('throttle:5,1')
        ->name('auth.password');

    // Phase 10a. `usage` and `consent` are cheap local reads and writes;
    // `explain` costs real money per call, so it carries the tighter throttle.
    Route::get('ai/usage', [AiController::class, 'usage'])->name('ai.usage');
    Route::put('ai/consent', [AiController::class, 'consent'])
        ->middleware('throttle:20,1')
        ->name('ai.consent');
    // The card doctor. Twenty cards a call, so the throttle is per batch and
    // a 20k-card sweep is a thousand of them — well inside the quota, which is
    // the real limit.
    Route::post('ai/grade', [AiController::class, 'grade'])
        ->middleware('throttle:120,60')
        ->name('ai.grade');
    Route::post('ai/explain', [AiController::class, 'explain'])
        ->middleware('throttle:30,60')
        ->name('ai.explain');

    Route::put('onboarding', [OnboardingController::class, 'update'])
        ->middleware('throttle:20,1')
        ->name('onboarding.update');

    // Deleting the account asks for the password again, so it is throttled
    // like a credential endpoint rather than like a normal authenticated call.
    Route::delete('account', [AccountController::class, 'destroy'])
        ->middleware('throttle:5,1')
        ->name('account.destroy');

    // Phase 8's unpaid item: the metadata has synced since Phase 5 and the
    // bytes never moved. The body is raw bytes, so the upload throttle is
    // generous — one deck of plates is a few hundred small files.
    Route::put('media/{sha256}', [MediaController::class, 'store'])
        ->where('sha256', '[a-fA-F0-9]{64}')
        ->middleware('throttle:600,1')
        ->name('media.store');
    Route::post('media/held', [MediaController::class, 'held'])->name('media.held');
    Route::get('media/{sha256}', [MediaController::class, 'show'])
        ->where('sha256', '[a-fA-F0-9]{64}')
        ->name('media.show');

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

    // Rating is a write, so it needs an account; the service additionally
    // requires an install, because a rating from somebody who never took the
    // deck is a number about its description.
    Route::put('marketplace/listings/{listing}/rating', [ListingController::class, 'rate'])
        ->middleware('throttle:30,1')
        ->name('marketplace.listings.rate');

    /*
     * Live collaboration (Phase 9).
     *
     * The channel authorizer lives here rather than at Laravel's default
     * `/broadcasting/auth` because this API has no session and no CSRF token —
     * a bearer client cannot reach a route behind the `web` middleware, and
     * mounting it inside this group is what lets Sanctum answer for it.
     */
    Route::post('broadcasting/auth', fn (Request $request) => Broadcast::auth($request))
        ->name('broadcasting.auth');

    Route::get('decks/{deck}/collaborators', [CollaborationController::class, 'index'])
        ->name('decks.collaborators.index');

    // Inviting sends nothing yet and still costs a row per call; the throttle is
    // what stops a deck's roster being used as a way to spam an address list.
    Route::post('decks/{deck}/collaborators', [CollaborationController::class, 'store'])
        ->middleware('throttle:20,60')
        ->name('decks.collaborators.store');

    Route::patch('decks/{deck}/collaborators/{collaborator}', [CollaborationController::class, 'update'])
        ->name('decks.collaborators.update');

    Route::delete('decks/{deck}/collaborators/{collaborator}', [CollaborationController::class, 'destroy'])
        ->name('decks.collaborators.destroy');

    Route::get('collaborations', [CollaborationController::class, 'invitations'])
        ->name('collaborations.index');

    Route::post('collaborations/{invitation}/accept', [CollaborationController::class, 'accept'])
        ->name('collaborations.accept');

    Route::delete('collaborations/{invitation}', [CollaborationController::class, 'decline'])
        ->name('collaborations.decline');

    /*
     * The document itself. No throttle on `store`: it is one debounced batch of
     * keystrokes, and a limit low enough to stop abuse is low enough to stop
     * typing. What bounds it is the per-update size cap and the fact that only
     * an invited editor can reach it at all.
     */
    Route::get('decks/{deck}/doc', [DocumentController::class, 'show'])->name('decks.doc.show');
    Route::post('decks/{deck}/doc/updates', [DocumentController::class, 'store'])->name('decks.doc.store');
    Route::post('decks/{deck}/doc/snapshot', [DocumentController::class, 'compact'])->name('decks.doc.compact');

    Route::middleware('can:moderate,'.Listing::class)->group(function (): void {
        Route::get('moderation/reports', [ModerationController::class, 'index'])
            ->name('moderation.reports.index');

        Route::post('moderation/reports/{report}/dismiss', [ModerationController::class, 'dismiss'])
            ->name('moderation.reports.dismiss');

        Route::post('moderation/listings/{listing}/takedown', [ModerationController::class, 'takedown'])
            ->name('moderation.listings.takedown');

        // The softer half of the pair. A queue with only a takedown button is a
        // queue where every judgement call becomes a takedown.
        Route::post('moderation/listings/{listing}/unlist', [ModerationController::class, 'unlist'])
            ->name('moderation.listings.unlist');

        Route::get('moderation/listings/{listing}/history', [ModerationController::class, 'history'])
            ->name('moderation.listings.history');

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

    // Public for the same reason the download is: a deck cloned signed out is
    // still a deck whose updates the person is entitled to be offered.
    Route::get('marketplace/updates', [ListingController::class, 'updates'])
        ->name('marketplace.updates');

    Route::get('marketplace/listings/{listing}', [ListingController::class, 'show'])
        ->name('marketplace.listings.show');

    // A published version's bytes, to anyone who may read that version. The
    // version's own manifest is the authorization list.
    Route::get('marketplace/listings/{listing}/versions/{version}/media/{sha256}', [MediaController::class, 'version'])
        ->where('sha256', '[a-fA-F0-9]{64}')
        ->name('marketplace.version.media');

    Route::get('marketplace/listings/{listing}/versions/{version}', [ListingController::class, 'version'])
        ->whereNumber('version')
        ->name('marketplace.listings.version');
});
