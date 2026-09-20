<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The AI ledger, and the two columns on `users` that give it a period.
 *
 * **`ai_usage` is append-only, like `reviews`, `doc_updates` and
 * `listing_moderation_events`** — and for the same reason all three are
 * (AI.md §3.2): the derived number has to be rebuildable from the log. A
 * `credits_remaining` column that drifts from the calls that spent it is a
 * support ticket nobody can answer. Quota is therefore a `SUM`, not a counter.
 *
 * One row per API call, **successful or not**. A refusal is an HTTP 200 with no
 * usable content and a truncation is a partial answer at full price; recording
 * only successes under-reports the bill by exactly the calls worth seeing.
 *
 * Both the token counts and the money are stored. Tokens are facts that never
 * change; `cost_micros` is billing truth at the time of the call; `price_version`
 * is what connected them. Dropping either makes the table un-auditable in one
 * direction or the other.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_usage', function (Blueprint $table): void {
            $table->uuid('id')->primary();

            // Nulled rather than deleted when an account goes. Billing records
            // outlive the account; personal data does not — the same shape as
            // `listing_installs` keeping no FK to a deleted deck.
            $table->foreignUuid('user_id')->nullable()->constrained()->nullOnDelete();

            $table->string('feature', 32);
            $table->uuid('job_id')->nullable();
            $table->string('model', 48);

            // `input_tokens` EXCLUDES cached tokens. Adding them double-counts;
            // ignoring them under-counts a cached workload by most of its bill.
            $table->unsignedInteger('input_tokens')->default(0);
            $table->unsignedInteger('cache_write_tokens')->default(0);
            $table->unsignedInteger('cache_read_tokens')->default(0);
            $table->unsignedInteger('output_tokens')->default(0);

            // Integer micro-dollars, never a float.
            $table->unsignedBigInteger('cost_micros')->default(0);
            $table->string('price_version', 16);

            $table->string('status', 16);           // ok|refusal|truncated|error
            $table->string('stop_reason', 24)->nullable();
            $table->string('request_id', 64)->nullable();
            $table->unsignedInteger('latency_ms')->default(0);
            $table->timestamp('created_at')->useCurrent();

            // The quota query, which runs before every single call.
            $table->index(['user_id', 'created_at']);
            $table->index('job_id');
        });

        // Rolled up monthly and pruned, because an append-only table with no
        // written compaction story is a performance incident scheduled for
        // month six — which is precisely what Phase 9's Yjs log taught.
        Schema::create('ai_usage_monthly', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('user_id')->nullable()->constrained()->nullOnDelete();
            $table->string('month', 7);             // YYYY-MM, UTC
            $table->unsignedInteger('calls')->default(0);
            $table->unsignedBigInteger('input_tokens')->default(0);
            $table->unsignedBigInteger('output_tokens')->default(0);
            $table->unsignedBigInteger('cost_micros')->default(0);
            $table->timestamps();

            $table->unique(['user_id', 'month']);
        });

        Schema::table('users', function (Blueprint $table): void {
            // Stored UTC, advanced by a scheduled command, never computed from
            // `now()` per request: a period derived from the wall clock grants a
            // second allowance across one DST boundary and denies one across the
            // other. Same bug shape as Phase 9's compaction watermark.
            $table->timestamp('ai_period_start')->nullable()->after('avatar');
            $table->string('ai_plan', 16)->default('free')->after('ai_period_start');
            // Documents leave the device, and this app's users chose
            // offline-first. Nothing is sent until this is set.
            $table->timestamp('ai_consent_at')->nullable()->after('ai_plan');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropColumn(['ai_period_start', 'ai_plan', 'ai_consent_at']);
        });
        Schema::dropIfExists('ai_usage_monthly');
        Schema::dropIfExists('ai_usage');
    }
};
