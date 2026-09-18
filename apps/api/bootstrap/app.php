<?php

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Middleware\TouchTokenExpiry;
use App\Support\ApiResponse;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        // Versioned in the path, because an installed app cannot be
        // force-updated and v1 has to keep answering after the web app has
        // moved on (PLAN.md §2.6).
        api: __DIR__.'/../routes/api.php',
        apiPrefix: 'api/v1',
        commands: __DIR__.'/../routes/console.php',
        channels: __DIR__.'/../routes/channels.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->api(append: [
            TouchTokenExpiry::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );

        // Every API failure leaves as `{ error: { code, message } }` with a
        // stable string code. Laravel's own shapes differ per exception, and an
        // old build cannot branch on prose.
        $exceptions->render(function (Throwable $e, Request $request) {
            if (! $request->is('api/*')) {
                return null;
            }

            return match (true) {
                $e instanceof ApiException => null, // renders itself
                $e instanceof ValidationException => ApiResponse::error(
                    ApiErrorCode::ValidationFailed,
                    $e->getMessage(),
                    $e->errors(),
                ),
                $e instanceof AuthenticationException => ApiResponse::error(
                    ApiErrorCode::Unauthenticated,
                    'Sign in again to keep syncing.',
                ),
                $e instanceof NotFoundHttpException => ApiResponse::error(
                    ApiErrorCode::NotFound,
                    'No such resource.',
                ),
                $e instanceof HttpExceptionInterface && $e->getStatusCode() === 429 => ApiResponse::error(
                    ApiErrorCode::RateLimited,
                    'Too many requests. Try again shortly.',
                ),
                default => null,
            };
        });
    })->create();
