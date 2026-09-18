<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Listing;
use App\Models\User;

/**
 * Who may publish, who may see a listing that is not distributing, and who may
 * act on the queue.
 */
class ListingPolicy
{
    /**
     * Publishing is gated on a verified email address, and this is the only
     * place that gate exists (PHASES §5: verification gates the marketplace, not
     * studying). Nothing publishes anonymously — a takedown notice has to reach
     * a person, and an unverified address is not one.
     */
    public function publish(User $user): bool
    {
        return $user->email_verified_at !== null;
    }

    /**
     * A listing that is not distributing is still visible to its publisher — the
     * draft / in review / published / removed state is *their* screen — and to a
     * moderator working the queue.
     */
    public function view(?User $user, Listing $listing): bool
    {
        return $listing->isDistributable()
            || ($user !== null && ($user->id === $listing->user_id || $user->is_moderator));
    }

    public function update(User $user, Listing $listing): bool
    {
        return $user->id === $listing->user_id;
    }

    public function moderate(User $user): bool
    {
        return (bool) $user->is_moderator;
    }
}
