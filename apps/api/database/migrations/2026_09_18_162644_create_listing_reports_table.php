<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The moderation queue, and the publisher's side of it.
 *
 * `kind` carries both intake paths PHASES §8 asks for: a report from a reader,
 * and a counter-notice from the publisher of something already taken down. They
 * share every column, and separating them into two tables would mean two queues
 * for one conversation about one listing.
 *
 * The reporter is nullable so an account deletion does not erase the record of a
 * report that was upheld.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('listing_reports', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('listing_id')->constrained()->cascadeOnDelete();
            $table->foreignUuid('reporter_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('kind', 16)->default('report');
            $table->string('reason', 32);
            $table->text('detail')->nullable();
            $table->string('status', 16)->default('open');
            $table->uuid('resolved_by')->nullable();
            $table->timestamp('resolved_at')->nullable();
            $table->text('resolution_note')->nullable();
            $table->timestamps();

            $table->index(['status', 'created_at']);
            $table->index(['listing_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('listing_reports');
    }
};
