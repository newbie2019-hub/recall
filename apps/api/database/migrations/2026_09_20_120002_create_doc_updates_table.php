<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The collaborative edit log: one row per Yjs update, in arrival order.
 *
 * **PHP never looks inside `payload`.** That is the architectural decision of
 * PHASES §9, not an implementation detail — Yjs updates are commutative, the
 * clients merge them, and a server that tried to interpret one would need a
 * CRDT implementation in PHP to do it. What Laravel does is store the bytes,
 * hand them back in order, and rebroadcast them.
 *
 * `seq` is an auto-increment, and it is the cursor a joining client resumes
 * from. Not a timestamp: two updates in the same millisecond are
 * indistinguishable, which is the same reason the sync cursor is a revision
 * counter (PHASES §5).
 *
 * ponytail: `payload` is base64 text, not a `BLOB`. It arrives base64 over
 * JSON and leaves the same way, so storing it decoded would mean this server
 * decoding and re-encoding bytes it has just promised not to read — 33% more
 * disk to keep the "opaque" claim literally true. Switch to `binary` the day
 * the log's size is the thing that hurts, and do the decode in the controller.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('doc_updates', function (Blueprint $table): void {
            $table->bigIncrements('seq');
            // The Y.Doc's name. One doc per deck today; a column rather than a
            // foreign key because the doc outlives nothing and the cascade below
            // is the only relationship that matters.
            $table->foreignUuid('deck_id')->constrained()->cascadeOnDelete();
            $table->foreignUuid('actor_id')->nullable()->constrained('users')->nullOnDelete();
            $table->longText('payload');
            $table->timestamp('created_at')->nullable();

            $table->index(['deck_id', 'seq']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('doc_updates');
    }
};
