<?php

use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\DeviceController;
use App\Http\Controllers\Api\V1\PasswordResetController;
use App\Http\Controllers\Api\V1\SyncController;
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

    Route::get('devices', [DeviceController::class, 'index'])->name('devices.index');
    Route::delete('devices/{device}', [DeviceController::class, 'destroy'])->name('devices.destroy');

    Route::get('sync', [SyncController::class, 'pull'])->name('sync.pull');
    Route::post('sync', [SyncController::class, 'push'])->name('sync.push');
});
