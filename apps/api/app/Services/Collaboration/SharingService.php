<?php

declare(strict_types=1);

namespace App\Services\Collaboration;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Models\Deck;
use App\Models\DeckCollaborator;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

/**
 * Invitations, roles and removals for a shared deck.
 *
 * The one rule worth stating out loud: **removing somebody removes their
 * access, not their edits.** A collaborator's work is already merged into the
 * document and into every other participant's copy, and "un-inviting" them
 * cannot unpick it — the CRDT has no notion of authorship to unwind. So this
 * file revokes a key and nothing else, and the UI says so rather than implying
 * a rollback that is not on offer.
 */
final readonly class SharingService
{
    public function __construct(private DeckAccess $access) {}

    /**
     * Invite an address. An account that already exists is attached
     * immediately; one that does not is a pending row waiting for a sign-up.
     *
     * Re-inviting somebody who is already a collaborator changes their role
     * rather than failing — it is what the person meant, and the alternative is
     * an error message telling them to use a different button for the same
     * intention.
     */
    public function invite(Deck $deck, User $inviter, string $email, string $role): DeckCollaborator
    {
        $email = mb_strtolower(trim($email));

        if (! in_array($role, DeckCollaborator::ROLES, true)) {
            throw new ApiException(ApiErrorCode::ValidationFailed, 'Unknown role.');
        }

        $invitee = User::query()->whereRaw('LOWER(email) = ?', [$email])->first();

        if ($invitee !== null && $invitee->id === $deck->user_id) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'That is the deck owner — they already have every permission there is.',
            );
        }

        $row = DeckCollaborator::query()->firstOrNew([
            'deck_id' => $deck->id,
            'invited_email' => $email,
        ]);

        $row->fill([
            'role' => $role,
            'invited_by' => $inviter->id,
            'user_id' => $invitee?->id ?? $row->user_id,
        ]);

        // An invitation is not access. It becomes access when the invitee
        // accepts it, even if they already had an account when it was sent —
        // otherwise anybody could add anybody's deck to their sidebar, and a
        // stranger's deck appearing in your app is a notification you did not
        // ask for at best.
        $row->save();

        return $row->refresh();
    }

    /** The invitee says yes. This is the moment anything is granted. */
    public function accept(DeckCollaborator $invitation, User $user): DeckCollaborator
    {
        if (mb_strtolower($invitation->invited_email) !== mb_strtolower($user->email)) {
            throw new ApiException(ApiErrorCode::Forbidden, 'That invitation is not yours.');
        }

        $invitation->forceFill([
            'user_id' => $user->id,
            'accepted_at' => $invitation->accepted_at ?? Carbon::now(),
        ])->save();

        return $invitation;
    }

    /** Change what somebody may do. Never applied to the owner — see `invite`. */
    public function setRole(DeckCollaborator $collaborator, string $role): DeckCollaborator
    {
        if (! in_array($role, DeckCollaborator::ROLES, true)) {
            throw new ApiException(ApiErrorCode::ValidationFailed, 'Unknown role.');
        }

        $collaborator->update(['role' => $role]);

        return $collaborator;
    }

    /**
     * Revoke access.
     *
     * Their edits stay. See the class comment — this is a key, not a diff.
     */
    public function remove(DeckCollaborator $collaborator): void
    {
        $collaborator->delete();
    }

    /**
     * Everyone on a deck, owner first, then members, then outstanding invites.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function roster(Deck $deck): Collection
    {
        $deck->loadMissing('user:id,name,email');

        $owner = collect([[
            'id' => null,
            'user_id' => $deck->user_id,
            'name' => $deck->user?->name,
            'email' => $deck->user?->email,
            'role' => DeckAccess::OWNER,
            'accepted_at' => $deck->created_at?->toIso8601String(),
        ]]);

        $members = DeckCollaborator::query()
            ->where('deck_id', $deck->id)
            ->with('user:id,name,email')
            ->orderByRaw('accepted_at IS NULL')
            ->orderBy('created_at')
            ->get()
            ->map(fn (DeckCollaborator $c): array => [
                'id' => $c->id,
                'user_id' => $c->user_id,
                'name' => $c->user?->name,
                // The invited address is shown to the people who may manage the
                // deck, because an invitation you cannot read is one you cannot
                // correct a typo in. It is *not* published on the presence
                // channel — see routes/channels.php.
                'email' => $c->invited_email,
                'role' => $c->role,
                'accepted_at' => $c->accepted_at?->toIso8601String(),
            ]);

        return $owner->concat($members);
    }

    /** Decks somebody has been invited to and has not answered yet. */
    public function pendingFor(User $user): Collection
    {
        return DeckCollaborator::query()
            ->whereNull('accepted_at')
            ->whereRaw('LOWER(invited_email) = ?', [mb_strtolower($user->email)])
            ->with(['deck:id,name,user_id', 'deck.user:id,name', 'inviter:id,name'])
            ->get()
            ->filter(fn (DeckCollaborator $c): bool => $c->deck !== null && $c->deck->deleted_at === null)
            ->map(fn (DeckCollaborator $c): array => [
                'id' => $c->id,
                'deck_id' => $c->deck_id,
                'deck_name' => $c->deck?->name,
                'role' => $c->role,
                'invited_by' => $c->inviter?->name,
                'created_at' => $c->created_at?->toIso8601String(),
            ])
            ->values();
    }

    /** Decks shared *with* this person that they have accepted. */
    public function sharedWith(User $user): Collection
    {
        return DeckCollaborator::query()
            ->active()
            ->where('user_id', $user->id)
            ->with(['deck:id,name,user_id,deleted_at', 'deck.user:id,name'])
            ->get()
            ->filter(fn (DeckCollaborator $c): bool => $c->deck !== null && $c->deck->deleted_at === null)
            ->map(fn (DeckCollaborator $c): array => [
                'deck_id' => $c->deck_id,
                'deck_name' => $c->deck?->name,
                'owner' => $c->deck?->user?->name,
                'role' => $c->role,
            ])
            ->values();
    }

    public function access(): DeckAccess
    {
        return $this->access;
    }
}
