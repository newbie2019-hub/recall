<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Mirrors `decks` in packages/core/src/schema.ts, plus what only a server needs.
 *
 * Ids are the client's: PLAN.md §2.6 makes every primary key client-generated so
 * a retried push is idempotent through `INSERT … ON DUPLICATE KEY UPDATE` rather
 * than through a dedupe table nobody maintains.
 *
 * `deleted_at` is a tombstone, not politeness. A pull tells a device what
 * changed since its cursor, and a row that was deleted has to be *something* to
 * report — a hard delete is invisible to every device that was offline when it
 * happened, and the deck reappears on their next push.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('decks', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->uuid('parent_id')->nullable();
            $table->string('name');
            $table->float('retention_target')->default(0.9);
            $table->unsignedInteger('new_per_day')->default(20);
            // Marketplace (Phase 8) reads this; nothing in Phase 5 writes it.
            $table->string('visibility')->default('private');
            $table->unsignedBigInteger('revision')->index();
            // The client's clock, kept for last-write-wins. Never trusted for
            // ordering — that is what `revision` is for.
            $table->unsignedBigInteger('client_updated_at');
            $table->timestamp('deleted_at')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'revision']);
            $table->index(['user_id', 'parent_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('decks');
    }
};
