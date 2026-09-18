<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The sync cursor is a per-user revision counter, not a timestamp.
 *
 * Every syncable row carries the counter's value at the moment it was written,
 * and a pull is `WHERE user_id = ? AND revision > ?`. Timestamps cannot do this
 * job: two rows written in the same millisecond are indistinguishable, and
 * `updated_at` is the client's clock, which PLAN.md §2.6 already says not to
 * trust. A counter is exact, survives clock changes, and makes cursor
 * pagination total rather than best-effort.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->unsignedBigInteger('sync_revision')->default(0)->after('remember_token');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropColumn('sync_revision');
        });
    }
};
