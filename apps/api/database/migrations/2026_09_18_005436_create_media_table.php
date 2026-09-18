<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Media, content-addressed by the sha256 of the bytes.
 *
 * The hash is the name, which is what makes an interrupted 40 MB upload resume
 * instead of restart, and what makes the same diagram pasted into twenty notes
 * cost one copy (PLAN.md §2.6). The bytes live on a disk, not in MySQL: a
 * medical deck is gigabytes of plates, and a database is the wrong place to
 * keep a gigabyte it never reads.
 *
 * Identity is (user_id, sha256) rather than sha256 alone. Deduplicating
 * across accounts would mean one person's upload is served from another
 * person's quota, and deleting an account would have to ask who else is
 * pointing at each blob. Phase 8's marketplace is where sharing gets designed;
 * it is not something to fall into by accident here.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('media', function (Blueprint $table): void {
            // A surrogate key, because the real identity is (user_id, sha256)
            // and Eloquent has no composite keys. The unique index below is what
            // actually enforces it; this column just gives the ORM something to
            // hold on to instead of a convincing lie about which column is the
            // primary one.
            $table->uuid('id')->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->string('sha256', 64);
            $table->string('mime');
            $table->unsignedBigInteger('size');
            $table->string('path');
            // Set once the last chunk lands. An upload that stopped halfway is a
            // row with a null completion, which is exactly what lets the client
            // ask "how much of this do you already have?" and resume.
            $table->timestamp('completed_at')->nullable();
            $table->unsignedBigInteger('revision');
            $table->timestamps();

            $table->unique(['user_id', 'sha256']);
            $table->index(['user_id', 'revision']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('media');
    }
};
