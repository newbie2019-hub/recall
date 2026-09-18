<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Who may work the moderation queue.
 *
 * A column rather than a roles table: there is one privilege in this product and
 * it is held by the people who run it. Set by hand in the database — deliberately
 * not mass-assignable, and there is no endpoint that grants it.
 *
 * ponytail: one boolean. A roles/permissions package is the upgrade the day
 * moderation is delegated to volunteers with different powers.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->boolean('is_moderator')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropColumn('is_moderator');
        });
    }
};
