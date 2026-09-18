<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One row per signed-in device, carrying both its token and its sync cursor.
 *
 * PLAN.md §2.6: the token and the cursor belong to the same row, so revoking a
 * device is one delete and cannot leave a cursor behind that nothing owns.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('devices', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->string('name');
            // The Sanctum token this device authenticates with. Nullable so a
            // device row outlives an expired token: the cursor is still correct
            // when the same device signs in again, and re-pulling the whole
            // collection because a token lapsed is exactly what a metered
            // connection cannot afford.
            $table->foreignUuid('token_id')->nullable()->constrained('personal_access_tokens')->nullOnDelete();
            $table->unsignedBigInteger('cursor')->default(0);
            $table->string('platform')->nullable();
            $table->timestamp('last_seen_at')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'last_seen_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('devices');
    }
};
