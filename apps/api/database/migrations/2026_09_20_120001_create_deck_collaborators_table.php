<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Who may open, edit or administer a shared deck.
 *
 * This table is the *only* thing standing between a shared deck and vandalism.
 * PHASES §9 and CRITIQUE.md both say why that matters more here than anywhere
 * else in the app: Laravel holds Yjs updates as opaque blobs it cannot parse,
 * so there is no server-side validation of collaborative content and no way to
 * reject a bad edit on its merits. Roles are the whole guard, which is why the
 * write role and the admin role are separate and why `viewer` exists at all.
 *
 * The owner is not a row here. Ownership is `decks.user_id`, and duplicating it
 * would create the state where a deck has two owners, or none.
 *
 * `user_id` is nullable because an invitation is sent to an *address*: the
 * person may not have an account yet, and the row has to exist before they do
 * or the invite has nowhere to live. It is filled in on acceptance, which is
 * also the moment the row starts granting anything.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('deck_collaborators', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('deck_id')->constrained()->cascadeOnDelete();
            $table->foreignUuid('user_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('invited_email');
            $table->string('role', 16);
            $table->foreignUuid('invited_by')->nullable()->constrained('users')->nullOnDelete();
            // Null means the invitation is still outstanding. Nothing is granted
            // until it is set, so an invitation that is never accepted is inert
            // rather than a standing key to somebody else's deck.
            $table->timestamp('accepted_at')->nullable();
            $table->timestamps();

            // One invitation per address per deck, and one membership per person
            // per deck. Two rows for one human is how a role change silently
            // fails to apply to the row that is actually being read.
            $table->unique(['deck_id', 'invited_email']);
            $table->unique(['deck_id', 'user_id']);
            $table->index(['user_id', 'accepted_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('deck_collaborators');
    }
};
