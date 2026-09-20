<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Who is working which report.
 *
 * The queue was offset-paged and unassigned, which is correct at zero decks and
 * wrong the first week two moderators work it at once: they open the same
 * report and duplicate the decision, and a new report arriving shifts the page
 * under whoever is reading it.
 *
 * A claim is a *soft* lock with an expiry rather than a hard assignment. A
 * moderator who claims three reports and closes their laptop must not park them
 * forever, and the alternative — an explicit release — is the step everybody
 * forgets. The index is the queue's own ordering, so the "unclaimed or expired"
 * filter is a range scan rather than a table sweep.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('listing_reports', function (Blueprint $table): void {
            $table->foreignUuid('claimed_by')->nullable()->after('status')->constrained('users')->nullOnDelete();
            $table->timestamp('claimed_at')->nullable()->after('claimed_by');

            // Keyset paging reads this, and so does the claim filter.
            $table->index(['status', 'created_at', 'id']);
        });
    }

    public function down(): void
    {
        Schema::table('listing_reports', function (Blueprint $table): void {
            $table->dropIndex(['status', 'created_at', 'id']);
            $table->dropConstrainedForeignId('claimed_by');
            $table->dropColumn('claimed_at');
        });
    }
};
