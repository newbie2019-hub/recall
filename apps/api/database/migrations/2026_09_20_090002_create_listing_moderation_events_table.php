<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Every moderation decision, in the order it was made. Append-only.
 *
 * This pays off the ponytail on `listings`: the three `moderated_*` columns hold
 * the *current* decision, so a reinstatement used to overwrite the takedown it
 * reversed. PHASES §8 asks for an audit trail, and a trail that keeps only the
 * last step is the one thing a counter-notice cannot be argued from — the
 * sequence "removed on the 3rd, counter-noticed on the 5th, reinstated on the
 * 9th" is the record, and each of those rows is now a row.
 *
 * Nothing here is ever updated or deleted. The moderator is nullable for the
 * same reason the reporter is: a moderator's account closing must not erase a
 * decision they made, and `ON DELETE SET NULL` is what keeps the row.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('listing_moderation_events', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('listing_id')->constrained()->cascadeOnDelete();
            $table->foreignUuid('moderator_id')->nullable()->constrained('users')->nullOnDelete();
            // publish · approve · unlist · takedown · dismiss · counter_notice
            $table->string('action', 24);
            // The state the listing was left in, so the trail can be read on its
            // own without replaying every publish to work out what was live.
            $table->string('resulting_status', 16);
            $table->text('reason')->nullable();
            $table->timestamps();

            $table->index(['listing_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('listing_moderation_events');
    }
};
