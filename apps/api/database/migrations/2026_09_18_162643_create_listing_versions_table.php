<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * An immutable published snapshot. Never updated, never deleted.
 *
 * `version` is an integer because the client's contract already is: migration 7
 * in packages/core/src/schema.ts gives `decks.source_version INTEGER`, so the
 * integer is the identity a cloner holds and `semver` is a display label the
 * publisher chose. Ordering reads the integer; humans read the label.
 *
 * `payload` is the whole deck as JSON — notes, note types, deck subtree, media
 * references. ponytail: a longText column, which is fine for a marketplace with
 * no decks in it and wrong for a 2 GB anatomy atlas. Move the payload to the
 * media disk and keep the checksum here once a version passes a few megabytes.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('listing_versions', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('listing_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('version');
            $table->string('semver', 32)->nullable();
            $table->text('changelog')->nullable();
            $table->longText('payload');
            $table->char('checksum', 64);
            $table->unsignedInteger('note_count')->default(0);
            $table->unsignedBigInteger('size_bytes')->default(0);
            // Recorded *with the version*, not on the account: a takedown notice
            // is about one publication, and the claim that was made at the time
            // is the thing a counter-notice argues with (PHASES §8).
            $table->string('rights_attestation', 32);
            $table->string('attested_ip', 45)->nullable();
            $table->timestamps();

            $table->unique(['listing_id', 'version']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('listing_versions');
    }
};
