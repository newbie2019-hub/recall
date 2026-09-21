<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Who studies alongside whom. One row per relationship, never two.
 *
 * The obvious shape — a row for "A follows B" and another for "B follows A" —
 * is how a friendship ends up half-removed: one side deletes their row, the
 * other still sees a friend, and nothing in the schema says the two disagree.
 * So the pair is stored once and read from both ends. `status` is not a column
 * for the same reason: whether this is `pending_in` or `pending_out` depends
 * entirely on who is asking, and a stored copy of it would be wrong for one of
 * the two people looking at it.
 *
 * `accepted_at` rather than a state string. Null is a request that has been
 * sent and nothing else — inert, the same way an unaccepted deck invitation is
 * — and the timestamp is both the flag and the answer to "since when".
 *
 * The unique index stops the same direction being asked twice. It cannot stop
 * A→B and B→A both existing, because that needs a constraint over an unordered
 * pair and the only portable way to express one is a generated column this
 * app's SQLite test database and its MySQL server spell differently. The
 * controller looks both ways before it inserts, and the worst a lost race can
 * produce is two pending rows that each accept independently — visible and
 * removable, not corrupt.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('friendships', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('requester_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUuid('addressee_id')->constrained('users')->cascadeOnDelete();
            $table->timestamp('accepted_at')->nullable();
            $table->timestamps();

            $table->unique(['requester_id', 'addressee_id']);
            // The inbox read: every request waiting on me. The unique index
            // above already serves the outbox, because `requester_id` leads it.
            $table->index(['addressee_id', 'accepted_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('friendships');
    }
};
