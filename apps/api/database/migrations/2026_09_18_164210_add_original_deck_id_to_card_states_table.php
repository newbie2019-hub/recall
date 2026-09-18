<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Where a card borrowed by a filtered deck goes home to (Phase 7).
     *
     * `deck_id` already syncs, so without this a second device receives a card
     * sitting in a filtered deck with no record of where it came from — and
     * emptying that deck there would have nowhere to send it. The pair only
     * means anything together.
     *
     * No foreign key, matching `deck_id` beside it: a card state can arrive
     * before the deck that it names, and the client is the one that resolves
     * that ordering.
     */
    public function up(): void
    {
        Schema::table('card_states', function (Blueprint $table): void {
            $table->uuid('original_deck_id')->nullable()->after('deck_id');
        });
    }

    public function down(): void
    {
        Schema::table('card_states', function (Blueprint $table): void {
            $table->dropColumn('original_deck_id');
        });
    }
};
