<?php

declare(strict_types=1);

use App\Http\Middleware\TouchLastSeen;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The green dot, and the whole of presence.
 *
 * Touched by {@see TouchLastSeen} on authenticated API requests, which is why
 * there is no Reverb channel for this: a heartbeat socket would be a second
 * presence system to keep honest, with its own reconnect and its own way of
 * being wrong, in exchange for a dot next to a name. The app already talks to
 * this API constantly; that traffic *is* the heartbeat.
 *
 * No index. It is read one row at a time alongside the friend it belongs to
 * and never filtered or sorted on — an index here would cost every heartbeat
 * write and serve no query.
 *
 * On `users` beside `avatar` for the same reason that one is: it is shown
 * wherever a person is shown, and those reads already have the row.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->timestamp('last_seen_at')->nullable()->after('avatar');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropColumn('last_seen_at');
        });
    }
};
