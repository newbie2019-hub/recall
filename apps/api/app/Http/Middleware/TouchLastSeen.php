<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Http\Resources\FriendResource;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/**
 * Presence, as a side effect of traffic that was happening anyway.
 *
 * There is no heartbeat socket and no Reverb channel behind the green dot. A
 * second live connection would be a second thing to reconnect, a second thing
 * to authorize and a second thing to be wrong about somebody's status — and
 * the app already talks to this API while it is open, which is the only signal
 * "online" ever meant.
 *
 * Throttled to one write a minute per account, the same bargain
 * {@see TouchTokenExpiry} strikes for the same reason: a review push is a
 * request, so writing on every request turns `users` into the busiest table in
 * the database to move a timestamp that only has to be roughly right.
 * `Cache::add` is the lock — it is atomic, so two requests arriving together
 * produce one write rather than two. The window is well inside
 * {@see FriendResource::ONLINE_WITHIN_MINUTES}, so the dot never goes out on
 * somebody who is still here.
 */
class TouchLastSeen
{
    /** Seconds between writes for one account. */
    private const EVERY = 60;

    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        // After the response, not before: this middleware sits on the API
        // group, which runs ahead of `auth:sanctum`, and on the way in there is
        // no user resolved yet to be seen.
        $user = $request->user();

        if ($user && Cache::add('last-seen:'.$user->getKey(), true, self::EVERY)) {
            // A targeted update rather than `$user->save()`, and the *base*
            // builder rather than Eloquent's, for two separate reasons.
            //
            // An account deleted earlier in this same request — `DELETE
            // /account` — leaves a model with `exists === false`, and `save()`
            // on that is an INSERT that quietly resurrects the row somebody
            // just asked to be rid of. A `where`d update touches nothing.
            //
            // `DB::table` because `Eloquent\Builder::update()` calls
            // `addUpdatedAtColumn()`, so going through the model would stamp
            // `updated_at` every minute and make every account in the system
            // look like it was being edited constantly. A heartbeat is not an
            // edit.
            DB::table('users')->where('id', $user->getKey())->update(['last_seen_at' => now()]);
        }

        return $response;
    }
}
