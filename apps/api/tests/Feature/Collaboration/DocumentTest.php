<?php

declare(strict_types=1);

namespace Tests\Feature\Collaboration;

use App\Events\DocUpdated;
use App\Models\DeckCollaborator;
use App\Models\DocUpdate;
use App\Services\Collaboration\DocumentService;
use Illuminate\Support\Facades\Event;

class DocumentTest extends CollaborationTestCase
{
    public function test_an_editor_appends_and_everyone_else_is_told(): void
    {
        Event::fake([DocUpdated::class]);

        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $editor = $this->account();
        $this->collaborator($deck, $editor, DeckCollaborator::ROLE_EDITOR);

        $this->actingAsToken($this->tokenFor($editor))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update()])
            ->assertCreated()
            ->assertJsonPath('data.seq', 1);

        $this->assertDatabaseHas('doc_updates', [
            'deck_id' => $deck->id,
            'actor_id' => $editor->id,
            'payload' => $this->update(),
        ]);

        Event::assertDispatched(
            DocUpdated::class,
            fn (DocUpdated $e): bool => $e->deckId === $deck->id && $e->payload === $this->update(),
        );
    }

    public function test_a_viewer_reads_the_document_and_cannot_write_to_it(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $viewer = $this->account();
        $this->collaborator($deck, $viewer, DeckCollaborator::ROLE_VIEWER);

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update('owner types')])
            ->assertCreated();

        $this->actingAsToken($this->tokenFor($viewer))
            ->getJson(route('decks.doc.show', $deck))
            ->assertOk()
            ->assertJsonCount(1, 'data.updates');

        // The whole anti-vandalism story: PHP cannot judge an update, so it
        // judges the sender (CRITIQUE.md §3).
        $this->actingAsToken($this->tokenFor($viewer))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update('viewer types')])
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');

        $this->assertSame(1, DocUpdate::query()->where('deck_id', $deck->id)->count());
    }

    public function test_a_stranger_cannot_read_or_write_the_document(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $stranger = $this->account();

        $this->actingAsToken($this->tokenFor($stranger))
            ->getJson(route('decks.doc.show', $deck))
            ->assertForbidden();

        $this->actingAsToken($this->tokenFor($stranger))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update()])
            ->assertForbidden();

        $this->anonymous()->getJson(route('decks.doc.show', $deck))->assertUnauthorized();
    }

    public function test_an_invitation_that_was_never_accepted_grants_nothing(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $invitee = $this->account();

        DeckCollaborator::query()->create([
            'deck_id' => $deck->id,
            'user_id' => $invitee->id,
            'invited_email' => $invitee->email,
            'role' => DeckCollaborator::ROLE_EDITOR,
            'invited_by' => $owner->id,
            // Not accepted.
        ]);

        $this->actingAsToken($this->tokenFor($invitee))
            ->getJson(route('decks.doc.show', $deck))
            ->assertForbidden();
    }

    public function test_a_resuming_client_gets_only_what_it_missed(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $token = $this->tokenFor($owner);

        foreach (['one', 'two', 'three'] as $text) {
            $this->actingAsToken($token)
                ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update($text)])
                ->assertCreated();
        }

        $response = $this->actingAsToken($token)
            ->getJson(route('decks.doc.show', [$deck, 'since' => 2]))
            ->assertOk();

        $this->assertCount(1, $response->json('data.updates'));
        $this->assertSame($this->update('three'), $response->json('data.updates.0.payload'));
        $this->assertSame(3, $response->json('data.cursor'));
        // A resume never re-sends the snapshot: the client already has it.
        $this->assertNull($response->json('data.snapshot'));
    }

    public function test_a_snapshot_replaces_the_updates_it_covers(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $token = $this->tokenFor($owner);

        foreach (['one', 'two', 'three'] as $text) {
            $this->actingAsToken($token)
                ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update($text)])
                ->assertCreated();
        }

        $this->actingAsToken($token)
            ->postJson(route('decks.doc.compact', $deck), [
                'payload' => $this->update('the whole document'),
                'up_to_seq' => 2,
            ])
            ->assertOk()
            ->assertJsonPath('data.up_to_seq', 2);

        $this->assertSame(1, DocUpdate::query()->where('deck_id', $deck->id)->count());

        // A client opening the deck now gets the snapshot plus the one update
        // that came after it — the same state, fewer rows.
        $response = $this->actingAsToken($token)->getJson(route('decks.doc.show', $deck))->assertOk();
        $this->assertSame($this->update('the whole document'), $response->json('data.snapshot'));
        $this->assertCount(1, $response->json('data.updates'));
        $this->assertSame($this->update('three'), $response->json('data.updates.0.payload'));
    }

    public function test_a_late_snapshot_never_moves_the_document_backwards(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $token = $this->tokenFor($owner);

        foreach (range(1, 4) as $n) {
            $this->actingAsToken($token)
                ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update('edit '.$n)])
                ->assertCreated();
        }

        $this->actingAsToken($token)->postJson(route('decks.doc.compact', $deck), [
            'payload' => $this->update('state at 4'), 'up_to_seq' => 4,
        ])->assertOk();

        // Two clients compacted at once and the older one arrived second.
        $this->actingAsToken($token)->postJson(route('decks.doc.compact', $deck), [
            'payload' => $this->update('state at 2'), 'up_to_seq' => 2,
        ])->assertOk()->assertJsonPath('data.up_to_seq', 4);

        $this->assertDatabaseHas('doc_snapshots', [
            'deck_id' => $deck->id,
            'payload' => $this->update('state at 4'),
        ]);
    }

    public function test_a_snapshot_claiming_updates_that_do_not_exist_is_refused(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.doc.compact', $deck), [
                'payload' => $this->update('from the future'),
                'up_to_seq' => 99,
            ])
            ->assertStatus(422);

        $this->assertDatabaseCount('doc_snapshots', 0);
    }

    public function test_a_viewer_cannot_compact_which_would_be_a_rewrite(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);
        $viewer = $this->account();
        $this->collaborator($deck, $viewer, DeckCollaborator::ROLE_VIEWER);

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.doc.store', $deck), ['payload' => $this->update()])
            ->assertCreated();

        $this->actingAsToken($this->tokenFor($viewer))
            ->postJson(route('decks.doc.compact', $deck), [
                'payload' => $this->update('nothing to see here'),
                'up_to_seq' => 1,
            ])
            ->assertForbidden();
    }

    public function test_a_payload_that_is_not_base64_is_refused(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.doc.store', $deck), ['payload' => 'not base64 !!!'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_an_oversized_update_is_refused(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);

        $this->actingAsToken($this->tokenFor($owner))
            ->postJson(route('decks.doc.store', $deck), [
                'payload' => str_repeat('A', DocumentService::MAX_UPDATE_BYTES + 4),
            ])
            ->assertStatus(413)
            ->assertJsonPath('error.code', 'payload_too_large');
    }

    public function test_the_client_is_asked_to_compact_once_the_log_is_long(): void
    {
        $owner = $this->account();
        $deck = $this->deckOwnedBy($owner);

        // Inserted directly: the point is the threshold, not 500 HTTP requests.
        $rows = array_map(fn (int $n): array => [
            'deck_id' => $deck->id,
            'actor_id' => $owner->id,
            'payload' => $this->update('edit '.$n),
            'created_at' => now(),
        ], range(1, DocumentService::COMPACT_AFTER));
        DocUpdate::query()->insert($rows);

        $this->actingAsToken($this->tokenFor($owner))
            ->getJson(route('decks.doc.show', $deck))
            ->assertOk()
            ->assertJsonPath('data.should_compact', true);
    }
}
