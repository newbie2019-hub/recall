<?php

declare(strict_types=1);

namespace Tests\Feature\Collaboration;

use App\Models\DeckCollaborator;

class SharingTest extends CollaborationTestCase
{
    public function test_an_invitation_grants_nothing_until_it_is_accepted(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $invitee = $this->account('kate@example.test');

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.collaborators.store', $deck), [
                'email' => 'KATE@example.test',
                'role' => DeckCollaborator::ROLE_EDITOR,
            ])
            ->assertCreated();

        // Attached to the account, because it exists — but inert.
        $this->assertDatabaseHas('deck_collaborators', [
            'deck_id' => $deck->id,
            'invited_email' => 'kate@example.test',
            'user_id' => $invitee->id,
            'accepted_at' => null,
        ]);

        $this->actingAsToken($this->tokenFor($invitee))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update()])
            ->assertForbidden();

        $invitation = DeckCollaborator::query()->firstOrFail();

        $this->actingAsToken($this->tokenFor($invitee))
            ->getJson(route('collaborations.index'))
            ->assertOk()
            ->assertJsonCount(1, 'data.pending')
            ->assertJsonPath('data.pending.0.deck_name', 'Anatomy');

        $this->actingAsToken($this->tokenFor($invitee))
            ->postJson(route('collaborations.accept', $invitation))
            ->assertOk()
            ->assertJsonPath('data.role', DeckCollaborator::ROLE_EDITOR);

        $this->actingAsToken($this->tokenFor($invitee))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update()])
            ->assertCreated();
    }

    public function test_an_address_with_no_account_waits_as_a_pending_row(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.collaborators.store', $deck), [
                'email' => 'nobody@example.test',
                'role' => DeckCollaborator::ROLE_VIEWER,
            ])
            ->assertCreated();

        // The invitation has to exist before the person does, or it has nowhere
        // to live between being sent and being signed up for.
        $this->assertDatabaseHas('deck_collaborators', [
            'invited_email' => 'nobody@example.test',
            'user_id' => null,
            'accepted_at' => null,
        ]);
    }

    public function test_somebody_elses_invitation_cannot_be_accepted(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.collaborators.store', $deck), [
                'email' => 'kate@example.test',
                'role' => DeckCollaborator::ROLE_ADMIN,
            ])
            ->assertCreated();

        $invitation = DeckCollaborator::query()->firstOrFail();
        $opportunist = $this->account('mallory@example.test');

        $this->actingAsToken($this->tokenFor($opportunist))
            ->postJson(route('collaborations.accept', $invitation))
            ->assertForbidden();

        $this->assertNull($invitation->refresh()->accepted_at);
    }

    public function test_only_the_owner_and_admins_may_change_the_roster(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $editor = $this->account();
        $admin = $this->account();
        $this->collaborator($deck, $editor, DeckCollaborator::ROLE_EDITOR);
        $adminRow = $this->collaborator($deck, $admin, DeckCollaborator::ROLE_ADMIN);

        // An editor may write the document and not the roster. That split is the
        // reason the two roles exist.
        $this->actingAsToken($this->tokenFor($editor))
            ->postJson(route('decks.collaborators.store', $deck), [
                'email' => 'someone@example.test',
                'role' => DeckCollaborator::ROLE_EDITOR,
            ])
            ->assertForbidden();

        $this->actingAsToken($this->tokenFor($admin))
            ->postJson(route('decks.collaborators.store', $deck), [
                'email' => 'someone@example.test',
                'role' => DeckCollaborator::ROLE_VIEWER,
            ])
            ->assertCreated();

        $this->assertNotNull($adminRow->refresh());
    }

    public function test_demoting_an_editor_stops_their_writes_immediately(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $editor = $this->account();
        $row = $this->collaborator($deck, $editor, DeckCollaborator::ROLE_EDITOR);

        $this->actingAsToken($this->tokenFor($editor))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update()])
            ->assertCreated();

        $this->actingAsToken($this->tokenFor($owner))
            ->patchJson(route('decks.collaborators.update', [$deck, $row]), [
                'role' => DeckCollaborator::ROLE_VIEWER,
            ])
            ->assertOk();

        $this->actingAsToken($this->tokenFor($editor))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update('after demotion')])
            ->assertForbidden();
    }

    public function test_removal_revokes_access_and_leaves_the_edits_alone(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $editor = $this->account();
        $row = $this->collaborator($deck, $editor, DeckCollaborator::ROLE_EDITOR);

        $this->actingAsToken($this->tokenFor($editor))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update('their work')])
            ->assertCreated();

        $this->actingAsToken($this->tokenFor($owner))
            ->deleteJson(route('decks.collaborators.destroy', [$deck, $row]))
            ->assertOk();

        $this->actingAsToken($this->tokenFor($editor))
            ->getJson(route('decks.doc.show', $deck))
            ->assertForbidden();

        // Their edits are merged into everybody's copy already; a CRDT has no
        // authorship to unwind, and this endpoint revokes a key, not a diff.
        $this->assertDatabaseHas('doc_updates', [
            'deck_id' => $deck->id,
            'payload' => $this->update('their work'),
        ]);
    }

    public function test_a_collaborator_can_leave_without_asking(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $editor = $this->account();
        $row = $this->collaborator($deck, $editor, DeckCollaborator::ROLE_EDITOR);

        $this->actingAsToken($this->tokenFor($editor))
            ->deleteJson(route('decks.collaborators.destroy', [$deck, $row]))
            ->assertOk();

        $this->assertDatabaseCount('deck_collaborators', 0);
    }

    public function test_a_collaborator_row_from_another_deck_cannot_be_deleted_through_yours(): void
    {
        $owner = $this->account();
        $mine = $this->deckOwnedBy($owner, 'Mine');

        $otherOwner = $this->account();
        $theirs = $this->deckOwnedBy($otherOwner, 'Theirs');
        $theirCollaborator = $this->collaborator($theirs, $this->account(), DeckCollaborator::ROLE_EDITOR);

        $this->actingAsToken($this->tokenFor($owner))
            ->deleteJson(route('decks.collaborators.destroy', [$mine, $theirCollaborator]))
            ->assertNotFound();

        $this->assertDatabaseHas('deck_collaborators', ['id' => $theirCollaborator->id]);
    }

    public function test_the_roster_shows_the_owner_first_and_marks_pending_invitations(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $editor = $this->account();
        $this->collaborator($deck, $editor, DeckCollaborator::ROLE_EDITOR);

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.collaborators.store', $deck), [
                'email' => 'waiting@example.test',
                'role' => DeckCollaborator::ROLE_VIEWER,
            ])
            ->assertCreated();

        $response = $this->actingAsToken($this->tokenFor($owner))
            ->getJson(route('decks.collaborators.index', $deck))
            ->assertOk();

        $this->assertSame('owner', $response->json('data.role'));
        $this->assertSame(
            ['owner', 'editor', 'viewer'],
            array_column($response->json('data.collaborators'), 'role'),
        );
        $this->assertNull($response->json('data.collaborators.2.accepted_at'));
    }

    public function test_inviting_the_owner_of_the_deck_is_refused(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.collaborators.store', $deck), [
                'email' => $owner->email,
                'role' => DeckCollaborator::ROLE_VIEWER,
            ])
            ->assertStatus(422);
    }

    public function test_declining_deletes_the_invitation(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $invitee = $this->account('kate@example.test');

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.collaborators.store', $deck), [
                'email' => $invitee->email,
                'role' => DeckCollaborator::ROLE_EDITOR,
            ])
            ->assertCreated();

        $invitation = DeckCollaborator::query()->firstOrFail();

        $this->actingAsToken($this->tokenFor($invitee))
            ->deleteJson(route('collaborations.decline', $invitation))
            ->assertOk();

        $this->assertDatabaseCount('deck_collaborators', 0);
    }
}
