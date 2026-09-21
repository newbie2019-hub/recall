<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Resources\FriendResource;
use App\Models\Friendship;
use App\Models\User;
use Illuminate\Database\Query\JoinClause;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Friends, and the one screen in this app that compares you to somebody else.
 *
 * Everything else the product measures — retention, streaks, the goal meter —
 * is you against your own past, on purpose. This is the exception, so it is
 * friends-only, it is a *window* rather than an all-time table, and there is no
 * directory to search: a request is addressed to an email somebody already
 * knows. A name search would hand anybody a way to enumerate the accounts on
 * this server, which nobody asked for.
 *
 * Authorization is spelled out here rather than in a policy, matching
 * {@see CollaborationController}: the checks are "is this row mine" and "was it
 * addressed to me", and a policy class for two lines is a second place to look
 * when one of them is wrong.
 */
class FriendController extends Controller
{
    use RespondsWithApi;

    /** The week, because that is the unit a study habit is felt in. */
    private const DEFAULT_DAYS = 7;

    /**
     * Everybody, in all three states, in one call.
     *
     * Not three endpoints: the friends screen draws accepted friends and both
     * directions of pending together, and splitting them would be three lists
     * to keep in step for no gain — the whole set is a handful of rows.
     */
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();

        $friendships = Friendship::query()
            ->involving($user)
            // Both sides eager loaded, because the resource reads whichever one
            // is not the caller and a lazy load here is one query per friend.
            ->with(['requester', 'addressee'])
            ->latest()
            ->get();

        return $this->ok(FriendResource::collection($friendships));
    }

    /**
     * Ask somebody, by the address they signed up with.
     *
     * **An address with no account is refused, not silently swallowed.** The
     * alternative — answering 201 and creating nothing — is the usual advice
     * for hiding whether an account exists, and it is dishonest here: this
     * endpoint returns the friendship row, and a fabricated one would carry an
     * id that 404s the moment the client tried to cancel it. There is no shape
     * of reply that both serves the contract and hides the answer, because a
     * *successful* request reveals the account just as loudly as a failed one
     * does. So the failure says as little as it can — one message for every
     * reason a request cannot be sent, never "no such user" — and the real
     * defence is the throttle on the route, which makes walking an address
     * list cost more than it is worth.
     */
    public function store(Request $request): JsonResponse
    {
        $user = $request->user();

        $data = $request->validate([
            'email' => ['required', 'email', 'max:255'],
        ]);

        $email = mb_strtolower(trim($data['email']));

        if ($email === mb_strtolower($user->email)) {
            throw new ApiException(ApiErrorCode::ValidationFailed, 'That is your own address.');
        }

        $other = User::query()->whereRaw('LOWER(email) = ?', [$email])->first();

        if ($other === null) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'We could not send a request to that address.',
            );
        }

        // Re-asking is what somebody does when they are not sure the first one
        // went through, so it answers with the row that already exists — in
        // either direction, and whatever its state. A duplicate would be a
        // second Accept button for one relationship; an error would be a
        // message telling them off for being careful.
        $existing = Friendship::query()
            ->between($user, $other)
            ->with(['requester', 'addressee'])
            ->first();

        if ($existing !== null) {
            return $this->created(new FriendResource($existing));
        }

        $friendship = Friendship::query()->create([
            'requester_id' => $user->id,
            'addressee_id' => $other->id,
        ]);

        $friendship->setRelation('requester', $user)->setRelation('addressee', $other);

        return $this->created(new FriendResource($friendship));
    }

    /**
     * Say yes. Only the person who was asked can.
     *
     * Accepting your own outgoing request would be a friendship the other
     * person never agreed to, which is the whole point of the pending state.
     */
    public function accept(Request $request, Friendship $friendship): JsonResponse
    {
        $user = $request->user();
        $this->mine($friendship, $user);

        if ($friendship->addressee_id !== $user->id) {
            throw new ApiException(ApiErrorCode::Forbidden, 'Only the person who was asked can accept.');
        }

        // Idempotent: a retried accept is the same friendship, not a reset of
        // the date it started.
        if ($friendship->accepted_at === null) {
            $friendship->forceFill(['accepted_at' => now()])->save();
        }

        return $this->ok(new FriendResource($friendship->load(['requester', 'addressee'])));
    }

    /**
     * Decline a request, or remove a friend. The same row, and deliberately the
     * same endpoint — there is only ever one row between two people, and two
     * verbs for deleting it would be two chances to delete the wrong one.
     *
     * Either party may. A friendship one person cannot leave is not one.
     */
    public function destroy(Request $request, Friendship $friendship): JsonResponse
    {
        $this->mine($friendship, $request->user());

        $friendship->delete();

        return $this->ok(['removed' => true]);
    }

    /**
     * The week, you and your friends, counted from the synced review log.
     *
     * Counted here rather than reported by the client, because a number a
     * device can choose is a number somebody will choose. A device that has not
     * synced is simply behind, which is the honest failure mode.
     */
    public function leaderboard(Request $request): JsonResponse
    {
        $user = $request->user();

        // Capped at a month. An all-time board is unwinnable by anybody who
        // joined late, which is the exact shape of discouragement this feature
        // is already on thin ice about.
        $validated = $request->validate([
            'days' => ['sometimes', 'integer', 'min:1', 'max:30'],
        ]);

        $days = (int) ($validated['days'] ?? self::DEFAULT_DAYS);
        $end = now();
        $start = $end->copy()->subDays($days);

        $ids = Friendship::query()
            ->accepted()
            ->involving($user)
            ->get(['requester_id', 'addressee_id'])
            ->flatMap(fn (Friendship $friendship): array => [
                $friendship->requester_id,
                $friendship->addressee_id,
            ])
            // Always present, even at zero reviews: a board you can fall off
            // is one that tells you nothing on the week you needed it most.
            ->push($user->id)
            ->unique()
            ->all();

        // One grouped aggregate for the whole board, not one count per friend.
        // The join hangs off `users` rather than `reviews` so that somebody who
        // studied nothing this week still comes back as a row of zeros, with
        // their name and avatar, instead of disappearing.
        $rows = User::query()
            ->leftJoin('reviews', function (JoinClause $join) use ($start, $end): void {
                $join->on('reviews.user_id', '=', 'users.id')
                    ->whereBetween('reviews.client_ts', [$start->getTimestampMs(), $end->getTimestampMs()])
                    // Answers replayed out of an .apkg are somebody else's
                    // history, not this week's work. Counting them would make
                    // the board winnable by importing a file.
                    ->where('reviews.imported', false);
            })
            ->whereIn('users.id', $ids)
            ->groupBy('users.id', 'users.name', 'users.avatar')
            // Aliased `review_count`, not `reviews`: `ORDER BY reviews` reads
            // as the table to anyone maintaining this, engine willing or not.
            ->orderByDesc('review_count')
            ->orderBy('users.name')
            ->toBase()
            ->get([
                'users.id',
                'users.name',
                'users.avatar',
                DB::raw('count(reviews.id) as review_count'),
                DB::raw('coalesce(sum(reviews.duration_ms), 0) as duration_ms'),
            ]);

        return $this->ok([
            'period_start' => $start->toIso8601String(),
            'period_end' => $end->toIso8601String(),
            'rows' => $rows->map(fn (object $row): array => [
                'user_id' => $row->id,
                'name' => $row->name,
                'avatar' => $row->avatar,
                'reviews' => (int) $row->review_count,
                'minutes' => (int) round(((int) $row->duration_ms) / 60_000),
                // Marked here so the client does not have to match ids itself.
                'is_you' => $row->id === $user->id,
            ])->all(),
        ]);
    }

    /**
     * A friendship you are not on does not exist, as far as you are concerned.
     *
     * Not 403: a 403 on a real id and a 404 on a made-up one is a way to ask
     * the server which friendship ids are real.
     */
    private function mine(Friendship $friendship, User $user): void
    {
        if (! $friendship->involves($user)) {
            throw new ApiException(ApiErrorCode::NotFound, 'No such friendship.');
        }
    }
}
