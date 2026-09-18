<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One row per uploaded `.apkg`, which is the thing the client polls.
 *
 * A row rather than a websocket because an import outlives the tab that started
 * it: a 200 MB medical deck takes minutes, the phone locks, and the answer has
 * to still be somewhere when it comes back (PHASES.md §5). Reverb is installed
 * and is still the wrong tool for this — a poll costs one indexed read and
 * survives a lost connection, where a socket has to be re-established and the
 * missed message replayed from somewhere anyway.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('import_jobs', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->string('original_name');
            // Where the upload sits until the worker picks it up. Deleted when
            // the job finishes either way: a failed import that keeps 200 MB
            // around is a disk that fills quietly.
            $table->string('path');
            $table->string('status', 16)->default('queued');
            $table->string('stage', 16)->default('reading');
            $table->unsignedInteger('done')->default(0);
            $table->unsignedInteger('total')->default(0);
            $table->json('report')->nullable();
            $table->text('error')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('import_jobs');
    }
};
