<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A generation run, and the cards it is suggesting.
 *
 * `ai_jobs` mirrors `import_jobs` deliberately — upload once, poll until done —
 * because it is the same shape of problem and the client already knows how to
 * wait for one.
 *
 * **`ai_candidates` is not `notes`, and the distance between them is the
 * feature.** The benchmark behind this phase found the best model reaching
 * 64.3% usable cards, with the dangerous failures being the ones that look
 * fine. Since `reviews` is append-only and FSRS derives from it, a bad card
 * compounds through the scheduler permanently. So nothing here becomes a note
 * until a human says so, and acceptance goes through the same path
 * `NoteEditor` uses — there is no "AI note" and no table for one.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_jobs', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('user_id')->constrained()->cascadeOnDelete();
            $table->string('kind', 16);                 // source
            $table->string('source_name');
            $table->string('source_path')->nullable();  // deleted when the job ends
            $table->string('status', 16)->default('queued');   // queued|running|done|failed|partial
            $table->string('stage', 16)->default('extracting');
            $table->unsignedInteger('done')->default(0);
            $table->unsignedInteger('total')->default(0);

            // What the job was allowed to spend, taken in the dispatch
            // transaction. A quota checked once at upload is a quota that
            // stopped existing at the second of eleven calls.
            $table->unsignedBigInteger('estimated_micros')->default(0);
            $table->unsignedBigInteger('reserved_micros')->default(0);

            $table->text('error')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'created_at']);
        });

        Schema::create('ai_candidates', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('ai_job_id')->constrained('ai_jobs')->cascadeOnDelete();

            // The note type is named, not keyed: the collection lives on the
            // device, so the server has no id to point at. The client matches
            // on name plus field signature, exactly as the importer does.
            $table->string('note_type', 64)->default('Basic');
            $table->json('fields');
            $table->json('tags');

            $table->unsignedTinyInteger('tier');        // 2 or 3 only; T0/T1 never land
            $table->string('dimension', 32)->default('ok');
            $table->string('grade_reason', 255)->default('');

            // Where it came from, shown beside the card on the approval screen
            // and discarded once accepted. A citation is for the reviewer, not
            // for the deck.
            $table->text('source_excerpt')->nullable();

            // Dedupes across re-runs and within a job, which is what makes
            // "regenerate this chunk" cheap and idempotent later.
            $table->char('content_hash', 64);
            $table->string('status', 12)->default('pending');  // pending|accepted|rejected
            $table->timestamps();

            $table->unique(['ai_job_id', 'content_hash']);
            $table->index(['ai_job_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_candidates');
        Schema::dropIfExists('ai_jobs');
    }
};
