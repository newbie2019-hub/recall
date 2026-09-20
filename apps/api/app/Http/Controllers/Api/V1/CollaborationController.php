<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Models\Deck;
use App\Models\DeckCollaborator;
use App\Services\Collaboration\SharingService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Who a deck is shared with: the list, the invitations, and the two changes.
 *
 * Every method authorizes against `DeckPolicy`, which delegates to the same
 * `DeckAccess` the websocket channel uses. That is the whole security model for
 * collaborative content — the server cannot inspect a Yjs update, so it decides
 * who may send one and nothing else (CRITIQUE.md §3).
 */
class CollaborationController extends Controller
{
    use RespondsWithApi;

    public function __construct(private readonly SharingService $sharing) {}

    /**
     * The app has no `AuthorizesRequests` trait on its base controller — the
     * marketplace spells its checks out the same way, and a second style of
     * authorization is a second place to look when one of them is wrong.
     */
    private function allow(Request $request, string $ability, Deck $deck): void
    {
        if (! $request->user()->can($ability, $deck)) {
            throw new ApiException(ApiErrorCode::Forbidden, 'Not your deck to do that with.');
        }
    }

    /** Everyone on the deck, owner first. Readable by anyone who may read it. */
    public function index(Request $request, Deck $deck): JsonResponse
    {
        $this->allow($request, 'view', $deck);

        return $this->ok([
            'role' => $this->sharing->access()->roleOn($request->user(), $deck),
            'collaborators' => $this->sharing->roster($deck)->all(),
        ]);
    }

    /** Invite an address. Owner and admins. */
    public function store(Request $request, Deck $deck): JsonResponse
    {
        $this->allow($request, 'manage', $deck);

        $validated = $request->validate([
            'email' => ['required', 'email', 'max:255'],
            'role' => ['required', Rule::in(DeckCollaborator::ROLES)],
        ]);

        $this->sharing->invite($deck, $request->user(), $validated['email'], $validated['role']);

        return $this->created(['collaborators' => $this->sharing->roster($deck)->all()]);
    }

    /** Change a role. */
    public function update(Request $request, Deck $deck, DeckCollaborator $collaborator): JsonResponse
    {
        $this->allow($request, 'manage', $deck);
        $this->sameDeck($deck, $collaborator);

        $validated = $request->validate([
            'role' => ['required', Rule::in(DeckCollaborator::ROLES)],
        ]);

        $this->sharing->setRole($collaborator, $validated['role']);

        return $this->ok(['collaborators' => $this->sharing->roster($deck)->all()]);
    }

    /**
     * Remove somebody, or leave a deck you were invited to.
     *
     * The second case is why this is not `manage`-only: a collaborator must be
     * able to get out of a deck without asking its owner's permission.
     */
    public function destroy(Request $request, Deck $deck, DeckCollaborator $collaborator): JsonResponse
    {
        $this->sameDeck($deck, $collaborator);

        $leaving = $collaborator->user_id !== null && $collaborator->user_id === $request->user()->id;

        if (! $leaving) {
            $this->allow($request, 'manage', $deck);
        }

        $this->sharing->remove($collaborator);

        // Somebody who has just left may no longer read the roster they would
        // otherwise be handed back.
        return $this->ok([
            'collaborators' => $leaving ? [] : $this->sharing->roster($deck)->all(),
        ]);
    }

    /** Invitations waiting for the signed-in account, and decks already joined. */
    public function invitations(Request $request): JsonResponse
    {
        return $this->ok([
            'pending' => $this->sharing->pendingFor($request->user())->all(),
            'shared_with_me' => $this->sharing->sharedWith($request->user())->all(),
        ]);
    }

    /**
     * Accept one.
     *
     * Deliberately not authorized by `DeckPolicy`: the invitee has no access to
     * the deck *yet*, and that is the state this endpoint exists to change. The
     * check is that the invitation's address is theirs, and it lives in the
     * service beside the write it guards.
     */
    public function accept(Request $request, DeckCollaborator $invitation): JsonResponse
    {
        $this->sharing->accept($invitation, $request->user());

        return $this->ok([
            'deck_id' => $invitation->deck_id,
            'role' => $invitation->role,
        ]);
    }

    /** Decline: the invitation is deleted, and nothing was ever granted. */
    public function decline(Request $request, DeckCollaborator $invitation): JsonResponse
    {
        if (mb_strtolower($invitation->invited_email) !== mb_strtolower($request->user()->email)) {
            throw new ApiException(ApiErrorCode::Forbidden, 'That invitation is not yours.');
        }

        $this->sharing->remove($invitation);

        return $this->ok(['declined' => true]);
    }

    /**
     * A collaborator row is addressed under its deck, so the two have to agree.
     *
     * Without this, `DELETE /decks/{mine}/collaborators/{somebody-elses-row}`
     * passes the policy check on a deck you administer and then deletes a row
     * belonging to a deck you have never seen.
     */
    private function sameDeck(Deck $deck, DeckCollaborator $collaborator): void
    {
        if ($collaborator->deck_id !== $deck->id) {
            throw new ApiException(ApiErrorCode::NotFound, 'No such collaborator on this deck.');
        }
    }
}
