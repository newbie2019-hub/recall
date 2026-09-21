<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A media row can exist before its bytes do.
 *
 * `media` had two creation paths and the schema only described one of them.
 * `MediaStore` and the importer write the file first and the row second, so
 * they always have somewhere to point `path`. **Sync does not**: a device
 * announces the hashes it holds so other devices learn the file exists, and the
 * bytes follow on the media endpoint afterwards — or never, if that device goes
 * offline first. A `NOT NULL` path made that announcement impossible and took
 * the whole sync request down with it.
 *
 * `completed_at` already modelled exactly this state ("an upload that stopped
 * halfway is a row with a null completion"); `path` simply had not been told.
 * Every reader of `path` is already gated on `completed_at` — `MediaStore::find`
 * and `::held`, and the marketplace manifest — so a null one is unreachable
 * rather than merely unlikely.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('media', function (Blueprint $table): void {
            $table->string('path')->nullable()->change();
        });
    }

    public function down(): void
    {
        Schema::table('media', function (Blueprint $table): void {
            $table->string('path')->nullable(false)->change();
        });
    }
};
