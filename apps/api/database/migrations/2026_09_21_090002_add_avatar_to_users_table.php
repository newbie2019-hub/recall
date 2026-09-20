<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Which of the drawn avatars this account picked.
 *
 * A key, never a URL or an upload. The pictures ship with the client, so there
 * is no file to store, no bucket to pay for, no image to moderate, and no
 * chance of somebody's face ending up on a public marketplace listing they did
 * not realise was public. A client that does not recognise the key falls back
 * to initials, which is also what a null means.
 *
 * On `users` rather than `user_profiles` because it is shown wherever a person
 * is shown — the app chrome, a collaborator list, a listing's byline — and
 * those reads already load the user.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->string('avatar', 32)->nullable()->after('email_verified_at');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropColumn('avatar');
        });
    }
};
