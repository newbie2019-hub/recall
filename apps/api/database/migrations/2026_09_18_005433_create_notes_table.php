<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Notes. `guid` is the identity that outlives this database.
 *
 * It is unique **per user**, not globally: two people can hold the same shared
 * deck, and its notes carry the same guids in both collections — that is what
 * makes a shared deck updatable rather than duplicated (CARDS.md §4.5). A global
 * unique index would make the second person's import fail.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('notes', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->string('guid', 64);
            $table->string('note_type_id', 64);
            $table->uuid('deck_id');
            $table->json('fields');
            $table->text('tags');
            $table->string('fma_id')->nullable();
            $table->integer('checksum')->nullable();
            $table->unsignedBigInteger('revision');
            $table->unsignedBigInteger('client_updated_at');
            $table->timestamp('deleted_at')->nullable();
            $table->timestamps();

            $table->unique(['user_id', 'guid']);
            $table->index(['user_id', 'revision']);
            $table->index(['user_id', 'deck_id']);
            $table->index(['user_id', 'fma_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('notes');
    }
};
