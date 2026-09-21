<?php

declare(strict_types=1);

namespace App\Http\Resources;

use App\Models\Friendship;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * A friendship as one of its two people sees it.
 *
 * `user` is always *the other person* and `status` always reads from the
 * request's own side, so the same row serialises to two different documents
 * depending on who asked. That is deliberate: it is what lets the client draw
 * the list without knowing which column it is in.
 *
 * @mixin Friendship
 */
class FriendResource extends JsonResource
{
    /**
     * How stale `last_seen_at` may be and still read as present.
     *
     * Five minutes against a heartbeat written at most once a minute — four
     * missed beats of slack, so a slow request or a phone between networks
     * does not blink the dot off somebody who is sitting right there.
     */
    public const ONLINE_WITHIN_MINUTES = 5;

    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $reader = $request->user();
        $other = $this->otherParty($reader);

        return [
            'id' => $this->id,
            'user' => [
                'id' => $other->id,
                'name' => $other->name,
                // A key into the client's own drawn avatars, never a URL.
                'avatar' => $other->avatar,
            ],
            'status' => $this->statusFor($reader),
            'online' => $other->last_seen_at !== null
                && $other->last_seen_at->gt(now()->subMinutes(self::ONLINE_WITHIN_MINUTES)),
            'last_seen_at' => $other->last_seen_at?->toIso8601String(),
        ];
    }
}
