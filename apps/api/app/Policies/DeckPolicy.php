<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Deck;
use App\Models\User;
use App\Services\Collaboration\DeckAccess;

/**
 * Deck authorization, which before Phase 9 was "you own it" everywhere.
 *
 * Sharing is the first time a deck has readers who are not its owner, so this
 * delegates to {@see DeckAccess} rather than re-deciding: the websocket channel
 * authorizes against the same object, and two implementations of one rule is
 * how a removed collaborator keeps a live connection.
 */
class DeckPolicy
{
    public function __construct(private readonly DeckAccess $access) {}

    public function view(User $user, Deck $deck): bool
    {
        return $this->access->canRead($user, $deck);
    }

    public function update(User $user, Deck $deck): bool
    {
        return $this->access->canWrite($user, $deck);
    }

    /** Invite, change a role, remove. Owner and admins. */
    public function manage(User $user, Deck $deck): bool
    {
        return $this->access->canManage($user, $deck);
    }
}
