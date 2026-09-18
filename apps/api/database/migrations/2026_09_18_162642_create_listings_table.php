<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A marketplace listing: one publisher's deck, offered to other people.
 *
 * The listing is a *pointer plus state*; the thing people actually download is a
 * row in `listing_versions`, which is immutable (PHASES §8). Keeping the two
 * apart is what makes "you have v3, v4 exists" answerable — a live pointer could
 * only ever say "the deck changed", which is not something a client can merge.
 *
 * `status` is the distribution switch and the publisher-facing state at once:
 * draft → in_review → published, and `removed` after a takedown. Nothing is ever
 * hard-deleted here, because a takedown has to leave a record of why.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('listings', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            // No FK to `decks`: a listing outlives the deck it was cut from, and
            // the versions are self-contained snapshots either way.
            $table->uuid('deck_id');
            $table->string('title');
            $table->text('description')->nullable();
            // Space-separated, the same shape `notes.tags` already uses, so the
            // browse filter and the card browser mean the same thing by "tag".
            $table->string('tags')->default('');
            $table->string('visibility', 16)->default('unlisted');
            $table->string('status', 16)->default('draft');
            $table->unsignedInteger('latest_version')->default(0);
            $table->unsignedInteger('install_count')->default(0);
            $table->unsignedInteger('open_report_count')->default(0);
            $table->timestamp('published_at')->nullable();
            // The audit trail for a moderation decision. Current state only —
            // ponytail: one row per listing, so a second takedown overwrites the
            // first decision's reason. A `listing_moderation_events` table is the
            // upgrade, needed the day two moderators disagree or a counter-notice
            // has to be reconstructed in order.
            $table->uuid('moderated_by')->nullable();
            $table->timestamp('moderated_at')->nullable();
            $table->text('moderation_reason')->nullable();
            $table->timestamps();

            // One listing per deck: re-publishing cuts a new version rather than
            // spawning a second listing that splits the same deck's installs.
            $table->unique(['user_id', 'deck_id']);
            $table->index(['status', 'visibility', 'published_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('listings');
    }
};
