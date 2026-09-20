<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Make marketplace search use an index.
 *
 * It was `LIKE '%term%'` over three columns, which cannot use an index by
 * construction — the leading wildcard makes a B-tree useless — so every search
 * scanned the whole table. Correct while the catalogue is twenty decks, wrong
 * at two thousand.
 *
 * **Guarded on the driver, and that guard is the point.** The test suite runs
 * on SQLite, which has no `FULLTEXT` index: a migration that assumed MySQL
 * would turn the whole suite red, which is exactly the trap the `ponytail:`
 * comment at the call site warned about. So the index is created only where it
 * exists, and `EloquentListingRepository::browse` keeps the `LIKE` path for
 * everywhere else. Two code paths is the honest cost of running the tests on a
 * different engine from production.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! $this->supportsFullText()) {
            return;
        }

        Schema::table('listings', function (Blueprint $table): void {
            $table->fullText(['title', 'description', 'tags'], 'listings_search_fulltext');
        });
    }

    public function down(): void
    {
        if (! $this->supportsFullText()) {
            return;
        }

        Schema::table('listings', function (Blueprint $table): void {
            $table->dropFullText('listings_search_fulltext');
        });
    }

    private function supportsFullText(): bool
    {
        return in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true);
    }
};
