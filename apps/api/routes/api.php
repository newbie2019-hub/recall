<?php

use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\DeviceController;
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

Route::middleware('auth:sanctum')->group(function (): void {
    Route::post('auth/logout', [AuthController::class, 'logout'])->name('auth.logout');
    Route::get('auth/me', [AuthController::class, 'me'])->name('auth.me');

    Route::get('devices', [DeviceController::class, 'index'])->name('devices.index');
    Route::delete('devices/{device}', [DeviceController::class, 'destroy'])->name('devices.destroy');

    Route::get('sync', [SyncController::class, 'pull'])->name('sync.pull');
    Route::post('sync', [SyncController::class, 'push'])->name('sync.push');
});
