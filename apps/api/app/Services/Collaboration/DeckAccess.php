<?php

declare(strict_types=1);

namespace App\Services\Collaboration;

use App\Models\Deck;
use App\Models\DeckCollaborator;
use App\Models\User;

/**
 * One answer to "what may this person do with this deck", used everywhere.
 *
 * It exists as a service rather than only as a policy because the *channel*
 * authorizer needs it too, and `routes/channels.php` is not a place a policy is
 * reachable from cleanly. A second copy of this rule living in the channel
 * callback is how a revoked collaborator keeps receiving every keystroke of a
 * deck they were removed from — the REST side would refuse them and the
 * websocket would not.
 *
 * Roles are ordered: admin implies editor implies viewer. The owner sits above
 * all three and is not a row in `deck_collaborators`.
 */
final readonly class DeckAccess
{
    public const OWNER = 'owner';

    /** Highest role this person holds on this deck, or null for none at all. */
    public function roleOn(?User $user, Deck $deck): ?string
    {
        if ($user === null) {
            return null;
        }

        if ($deck->user_id === $user->id) {
            return self::OWNER;
        }

        $membership = DeckCollaborator::query()
            ->active()
            ->where('deck_id', $deck->id)
            ->where('user_id', $user->id)
            ->first();

        return $membership?->role;
    }

    /** Open the document and the presence channel. */
    public function canRead(?User $user, Deck $deck): bool
    {
        return $this->roleOn($user, $deck) !== null;
    }

    /** Send updates into the document. */
    public function canWrite(?User $user, Deck $deck): bool
    {
        return in_array(
            $this->roleOn($user, $deck),
            [self::OWNER, DeckCollaborator::ROLE_ADMIN, DeckCollaborator::ROLE_EDITOR],
            true,
        );
    }

    /** Invite, change a role, remove somebody. */
    public function canManage(?User $user, Deck $deck): bool
    {
        return in_array(
            $this->roleOn($user, $deck),
            [self::OWNER, DeckCollaborator::ROLE_ADMIN],
            true,
        );
    }

    /**
     * Whether a deck is shared at all.
     *
     * The client asks so it knows whether to open a websocket for a deck that
     * only one person has ever touched — most decks are private, and a
     * connection per deck for an audience of one is a cost with no benefit.
     */
    public function isShared(Deck $deck): bool
    {
        return DeckCollaborator::query()->active()->where('deck_id', $deck->id)->exists();
    }
}
