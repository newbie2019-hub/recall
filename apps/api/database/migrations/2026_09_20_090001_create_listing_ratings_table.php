<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One rating, by one person who actually cloned the deck.
 *
 * The install requirement is the whole design. A star rating anybody can leave
 * is a number about how a listing *reads*, and the one thing a cloner needs to
 * know is whether the cards were worth studying — so the right to rate is earned
 * by `listing_installs`, checked at write time. That is also why there is no
 * review text: a sentence invites a review section, a review section invites
 * moderation of review text, and PHASES §8 already bought one moderation queue.
 *
 * `rating_sum` and `rating_count` are denormalised onto `listings` rather than
 * aggregated per request: browse orders by install count and prints an average
 * for twenty tiles at once, and a GROUP BY across two tables for two numbers is
 * a join this table exists to avoid. Both are written inside the same
 * transaction as the rating row, so they cannot drift.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('listing_ratings', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('listing_id')->constrained()->cascadeOnDelete();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->unsignedTinyInteger('stars');
            $table->timestamps();

            // Re-rating replaces, never appends: one person is one opinion, and
            // the unique index is what makes "change my mind" an update.
            $table->unique(['listing_id', 'user_id']);
        });

        Schema::table('listings', function (Blueprint $table): void {
            $table->unsignedInteger('rating_count')->default(0)->after('install_count');
            $table->unsignedInteger('rating_sum')->default(0)->after('rating_count');
        });
    }

    public function down(): void
    {
        Schema::table('listings', function (Blueprint $table): void {
            $table->dropColumn(['rating_count', 'rating_sum']);
        });

        Schema::dropIfExists('listing_ratings');
    }
};
