<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The review log. APPEND ONLY — no UPDATE, no DELETE, ever.
 *
 * This is the only irreplaceable data in the product (PLAN.md §2.5). Everything
 * else can be re-pulled or regenerated; a review that never left the device and
 * then got evicted by Safari is simply gone. Hence: pushed eagerly at session
 * end, and never rewritten here.
 *
 * Both timestamps, deliberately (PLAN.md §2.6). `client_ts` is what
 * `replayReviews()` orders by, because it is the order the person actually
 * answered in — including on a plane with a wrong clock. `server_received_at` is
 * what the server trusts for anything it decides itself. Absurd client values
 * are clamped on the way in, never rewritten: a lie recorded honestly is worth
 * more than a correction that loses what the device claimed.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('reviews', function (Blueprint $table): void {
            // Client-generated, so a retried push is idempotent for free — the
            // append-only rule paying for itself again (PLAN.md §2.6).
            $table->uuid('id')->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->string('card_id', 80);
            $table->unsignedBigInteger('client_ts');
            $table->unsignedBigInteger('server_received_at');
            $table->unsignedTinyInteger('rating');
            $table->unsignedInteger('duration_ms')->default(0);
            // An answer that arrived through an .apkg rather than from a person
            // sitting here. Undo must never eat one, and the dashboard counts
            // them separately from what was actually studied on this account.
            $table->boolean('imported')->default(false);
            $table->unsignedBigInteger('revision');
            $table->timestamp('created_at')->nullable();

            $table->index(['user_id', 'revision']);
            $table->index(['user_id', 'card_id', 'client_ts']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('reviews');
    }
};
