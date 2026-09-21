<?php

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Middleware\TouchLastSeen;
use App\Http\Middleware\TouchTokenExpiry;
use App\Support\ApiResponse;
use Illuminate\Auth\Access\AuthorizationException;
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
            // Presence, written at most once a minute per account. It is here
            // rather than on a channel because the app's own traffic is the
            // only heartbeat the green dot ever needed.
            TouchLastSeen::class,
        ]);

        // Sync carries a collection, not a form.
        //
        // Laravel turns `""` into `null` everywhere, which is right for a human
        // leaving a field blank and wrong for a row a device is reporting: a
        // note type with no CSS, a note with no tags and a cloze with an empty
        // "Back Extra" all legitimately hold an empty string, and every one of
        // them arrived here as NULL against a NOT NULL column. All seven
        // built-in note types ship with `css: ''`, so this was a 500 on the
        // first sync of a new account, on the one endpoint that has no other
        // way to make progress.
        $middleware->convertEmptyStringsToNull(except: [
            fn (Request $request) => $request->is('api/v1/sync'),
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
                // Without this arm every 403 in the app leaves as Laravel's
                // bare {message}, and a client that branches on stable error
                // codes has nothing to branch on.
                $e instanceof AuthorizationException => ApiResponse::error(
                    ApiErrorCode::Forbidden,
                    $e->getMessage() !== '' ? $e->getMessage() : 'Not allowed.',
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
