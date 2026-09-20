<?php

use App\Models\Deck;
use App\Models\User;
use App\Services\Collaboration\DeckAccess;
use Illuminate\Support\Facades\Broadcast;

Broadcast::channel('App.Models.User.{id}', function ($user, $id) {
    return (int) $user->id === (int) $id;
});

/**
 * One shared deck's live session (Phase 9).
 *
 * Authorized through {@see DeckAccess}, the same object the REST endpoints and
 * `DeckPolicy` use. That is deliberate: a websocket subscription outlives the
 * request that opened it, so a second copy of this rule is how somebody removed
 * from a deck keeps receiving every keystroke in it.
 *
 * Returning an array joins the presence channel and *publishes those fields to
 * every other member*, so this list is a decision about what collaborators
 * learn about each other. Name and role, never the email address: sharing a
 * deck with a study group should not hand everyone in it your address.
 *
 * A `viewer` is admitted. Reading the channel is what viewing a live document
 * means; what stops them writing is that the update endpoint refuses them, not
 * their absence from here.
 */
Broadcast::channel('deck.{deckId}', function (User $user, string $deckId): array|bool {
    $deck = Deck::query()->whereNull('deleted_at')->find($deckId);

    if ($deck === null) {
        return false;
    }

    $role = app(DeckAccess::class)->roleOn($user, $deck);

    return $role === null ? false : ['id' => $user->id, 'name' => $user->name, 'role' => $role];
});
