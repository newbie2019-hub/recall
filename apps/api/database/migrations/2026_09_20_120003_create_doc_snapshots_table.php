<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The compacted state of one deck's Y.Doc, and the update it is current to.
 *
 * Compaction is what stops `doc_updates` growing forever — PHASES §9 calls it
 * "the piece that bites six months in", and a deck edited daily for a year is
 * hundreds of thousands of rows a new joiner would otherwise download and
 * replay one by one.
 *
 * **The snapshot is produced by a client, not by this server, and that follows
 * from the same decision that makes the log opaque.** Merging updates into a
 * single state vector *is* running Yjs, and there is no Yjs in PHP. So a client
 * that already holds the whole document encodes it, posts it here, and the
 * server deletes every update at or below `up_to_seq` — the one operation it
 * can perform safely, because "these bytes supersede those rows" is a claim
 * about ordering rather than about content.
 *
 * The scheduled command (`collab:compact`) therefore prunes and reports; it
 * cannot compact a deck nobody has opened. That is written down in the command
 * rather than discovered later.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('doc_snapshots', function (Blueprint $table): void {
            $table->foreignUuid('deck_id')->primary()->constrained()->cascadeOnDelete();
            $table->longText('payload');
            $table->unsignedBigInteger('up_to_seq');
            $table->foreignUuid('actor_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('doc_snapshots');
    }
};
