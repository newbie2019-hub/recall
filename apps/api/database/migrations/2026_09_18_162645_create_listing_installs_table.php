<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Who cloned what, at which version.
 *
 * Bookkeeping only. The clone itself is a deck in the cloner's own collection
 * and is *not* referenced by a foreign key here on purpose: a takedown must not
 * be able to reach into anybody's collection (PHASES §8), and a cascade from
 * this table is exactly the mechanism that would let it.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('listing_installs', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('listing_id')->constrained()->cascadeOnDelete();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->uuid('deck_id');
            $table->unsignedInteger('version');
            $table->timestamps();

            // One install row per cloned deck. Cloning the same listing twice is
            // two decks and therefore two rows, which is what makes "which of my
            // decks has an update" a lookup rather than a guess.
            $table->unique(['user_id', 'deck_id']);
            $table->index(['listing_id', 'version']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('listing_installs');
    }
};
