<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The parts of a card a *person* decided, and only those.
 *
 * PLAN.md §2 rule 1 makes scheduling state a derived cache: `due`, `stability`,
 * `difficulty`, `state`, `reps` and `lapses` are rebuilt by replaying the
 * append-only review log, so syncing them would be shipping a cache across the
 * network and then arguing with it about which copy is right. A device that
 * pulls the notes and the reviews can regenerate every one of those columns.
 *
 * What it cannot regenerate is what someone chose: suspending a card, flagging
 * it, burying it until tomorrow, or a template override moving it to another
 * deck. None of that is in the log, so it lives here and syncs like content.
 *
 * The id is `<note id>:<ord>`, derived rather than random, which is what lets a
 * card come back after its template stopped generating it and find its own
 * history again.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('card_states', function (Blueprint $table): void {
            $table->string('id', 80)->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->uuid('note_id');
            $table->unsignedInteger('ord');
            $table->boolean('suspended')->default(false);
            $table->unsignedBigInteger('buried_until')->nullable();
            $table->unsignedTinyInteger('flag')->default(0);
            // Template deck override. NULL means "follow the note", which is
            // every card until an import says otherwise.
            $table->uuid('deck_id')->nullable();
            $table->unsignedBigInteger('revision');
            $table->unsignedBigInteger('client_updated_at');
            $table->timestamp('deleted_at')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'revision']);
            $table->index(['user_id', 'note_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('card_states');
    }
};
