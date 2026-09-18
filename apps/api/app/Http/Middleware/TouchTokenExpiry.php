<?php

namespace App\Http\Middleware;

use App\Services\Auth\AuthService;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Symfony\Component\HttpFoundation\Response;

/**
 * Sliding expiry: any authenticated request pushes the window out again.
 *
 * A token that never expires is a standing liability on a lost phone; a
 * short-lived one breaks someone studying on a plane for a fortnight. Sixty days
 * of *no sync at all* is the point where asking for a password again is
 * reasonable rather than hostile (PLAN.md §2.6).
 *
 * Throttled to one write per day per token. Without that, every review push
 * would write to `personal_access_tokens`, turning a read-mostly table into the
 * busiest one in the database for no gain — the window only has to be roughly
 * right.
 */
class TouchTokenExpiry
{
    public function handle(Request $request, Closure $next): Response
    {
        $token = $request->user()?->currentAccessToken();

        if ($token && $token->exists) {
            $fresh = Carbon::now()->addDays(AuthService::TOKEN_LIFETIME_DAYS);

            if (! $token->expires_at || $token->expires_at->lt($fresh->copy()->subDay())) {
                $token->forceFill([
                    'expires_at' => $fresh,
                    'last_used_at' => Carbon::now(),
                ])->save();
            }
        }

        return $next($request);
    }
}
