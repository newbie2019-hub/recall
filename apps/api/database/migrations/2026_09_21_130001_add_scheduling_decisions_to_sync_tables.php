<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Two scheduling decisions and one birthday, all of which are the client's.
 *
 * `card_states` deliberately carries only what a person chose, never the FSRS
 * cache — that is the whole point of the table. A due date somebody picked and
 * a card somebody reset are choices, so they belong here; without them "set due
 * date" and "forget" are local-only gestures that never reach a second device.
 *
 * `client_created_at` is named for the client because `notes` already has
 * Laravel's own `created_at`, and the existing `client_updated_at` set the
 * convention. Nullable rather than defaulted: a row pushed before this
 * migration genuinely does not know, and 0 would be a claim about 1970.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('card_states', function (Blueprint $table): void {
            $table->unsignedBigInteger('due_override')->nullable()->after('deck_id');
            $table->unsignedBigInteger('forgotten_at')->nullable()->after('due_override');
        });

        Schema::table('notes', function (Blueprint $table): void {
            $table->unsignedBigInteger('client_created_at')->nullable()->after('client_updated_at');
        });
    }

    public function down(): void
    {
        Schema::table('card_states', function (Blueprint $table): void {
            $table->dropColumn(['due_override', 'forgotten_at']);
        });

        Schema::table('notes', function (Blueprint $table): void {
            $table->dropColumn('client_created_at');
        });
    }
};
