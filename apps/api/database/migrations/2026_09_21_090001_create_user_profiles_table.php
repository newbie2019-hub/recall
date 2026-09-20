<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What a new account tells us about itself, once.
 *
 * **A table rather than columns on `users`, for two reasons.** This is a
 * marketing dataset and marketing datasets grow columns — every campaign wants
 * one more field, and `users` is read on every authenticated request in the
 * app. And the two have different lifetimes: `users` is the credential, this is
 * a survey answer that may be re-asked, exported, or dropped wholesale without
 * touching anybody's ability to sign in.
 *
 * `completed_at` is the only column the *product* reads. Null means the wizard
 * was started and abandoned, which is a row worth keeping: a profile that
 * stopped at "what do you study" is itself a finding about the wizard.
 *
 * ponytail: the free-text `*_other` columns are unmoderated user input shown
 * to nobody but us. If they ever surface in an admin UI, escape at render —
 * this table is not the place to sanitise, because trimming an answer is how a
 * dataset quietly stops matching what people actually typed.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_profiles', function (Blueprint $table): void {
            $table->uuid('id')->primary();

            // One profile per account. The unique index is what makes the
            // endpoint an upsert rather than an append — a reload in the wizard
            // must not leave two half-answers behind.
            $table->foreignUuid('user_id')->unique()->constrained()->cascadeOnDelete();

            $table->string('role', 32);
            $table->char('country', 2)->nullable();
            $table->string('subject', 64);
            $table->string('subject_other', 120)->nullable();
            $table->string('level', 32);
            $table->json('goals');
            $table->unsignedSmallInteger('daily_minutes')->nullable();
            $table->date('exam_date')->nullable();
            $table->string('heard_from', 32);
            $table->string('heard_from_other', 120)->nullable();
            $table->string('referral_code', 64)->nullable();
            $table->timestamp('completed_at')->nullable();
            $table->timestamps();

            // The three columns a question actually groups by: "where do people
            // come from", "what do they study", "did that campaign work".
            $table->index('heard_from');
            $table->index('subject');
            $table->index('referral_code');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_profiles');
    }
};
