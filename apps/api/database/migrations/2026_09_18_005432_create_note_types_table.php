<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Note types, including the ones an import brought in.
 *
 * The id is a string rather than a uuid because it legitimately is not one: the
 * built-ins are `basic`, `cloze`, `image-occlusion`, and an imported Anki type
 * is `anki:<mid>` so that re-importing the same deck updates it instead of
 * duplicating it. All three have to survive the round trip to the server
 * unchanged.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('note_types', function (Blueprint $table): void {
            $table->string('id', 64)->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->json('fields');
            $table->json('templates');
            $table->longText('css');
            $table->string('kind', 16)->default('standard');
            $table->string('ord_field')->nullable();
            $table->unsignedInteger('sort_field')->default(0);
            $table->json('field_config');
            // latexPre/latexPost/bqfmt/bafmt/originalStockKind, carried opaque so
            // a round trip through us does not degrade somebody's deck.
            $table->json('anki_extra');
            $table->boolean('builtin')->default(false);
            $table->unsignedBigInteger('revision');
            $table->unsignedBigInteger('client_updated_at');
            $table->timestamp('deleted_at')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'revision']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('note_types');
    }
};
