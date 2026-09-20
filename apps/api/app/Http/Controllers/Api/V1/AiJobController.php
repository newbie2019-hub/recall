<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Jobs\GenerateCardsJob;
use App\Models\AiCandidate;
use App\Models\AiJob;
use App\Services\Ai\Claude;
use App\Services\Ai\Ledger;
use App\Services\Ai\SourceText;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Upload a document, wait, decide which suggestions to keep.
 *
 * Shaped like the `.apkg` importer — create, poll, report — because the client
 * already knows that shape and the work is the same kind of long.
 *
 * Two things here are not plumbing:
 *
 * **The estimate is returned before anything runs.** "This will use about a
 * fifth of your month" is the only honest way to let somebody decide, and a
 * subsystem that spends first and reports after is one they are right not to
 * trust.
 *
 * **Acceptance returns notes rather than writing them.** The collection lives
 * on the device; the server holds a sync log. So accepting hands the client
 * ordinary note data and the client writes it through the same path
 * `NoteEditor` uses — which is what keeps generated cards from being a
 * different kind of note, with their own GUID rules and their own bugs.
 */
class AiJobController extends Controller
{
    use RespondsWithApi;

    /** A source document. Bigger than this is a book. */
    private const MAX_UPLOAD = 25 * 1024 * 1024;

    public function __construct(
        private readonly Ledger $ledger,
        private readonly SourceText $source,
    ) {}

    /**
     * Take a document and start a run.
     *
     * The cost is estimated from the extracted text *before* the job is
     * queued, inside the transaction that creates it. A quota checked outside
     * that transaction is two tabs passing the same check.
     */
    public function store(Request $request): JsonResponse
    {
        $user = $request->user();

        if (! Claude::configured()) {
            throw new ApiException(ApiErrorCode::AiUnavailable, 'AI features are not configured on this server.');
        }

        if ($user->ai_consent_at === null) {
            throw new ApiException(
                ApiErrorCode::AiConsentRequired,
                'Turn on AI features in Settings first — nothing is sent until you do.',
            );
        }

        $request->validate([
            'file' => ['required', 'file', 'max:'.(self::MAX_UPLOAD / 1024)],
        ]);

        $upload = $request->file('file');
        $name = mb_substr($upload->getClientOriginalName(), 0, 180);

        // Extracted here, not in the job, because the estimate depends on it
        // and an estimate after dispatch is an estimate nobody can act on. A
        // file with no readable text fails now, with a reason, having spent
        // nothing.
        $chunks = $this->source->chunks(
            $this->source->extract($upload->getRealPath(), $name, $upload->getMimeType() ?? 'text/plain'),
        );

        $estimate = $this->estimate(count($chunks));

        if (! $this->ledger->canSpend($user, $estimate)) {
            throw new ApiException(
                ApiErrorCode::AiQuotaExceeded,
                'That document would cost more than the allowance you have left this month.',
            );
        }

        // One job at a time per account: four jobs in flight all back off
        // together on a 429 and stampede when they wake.
        $running = AiJob::query()
            ->where('user_id', $user->id)
            ->whereIn('status', [AiJob::STATUS_QUEUED, AiJob::STATUS_RUNNING])
            ->exists();

        if ($running) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'One document at a time. Wait for the current one to finish.',
            );
        }

        $path = $upload->store("ai/{$user->id}");

        $job = DB::transaction(function () use ($user, $name, $path, $chunks, $estimate): AiJob {
            // Locked for the length of the check-and-create, which is what
            // makes two tabs safe rather than hopeful.
            DB::table('users')->where('id', $user->id)->lockForUpdate()->first();

            return AiJob::query()->create([
                'id' => (string) Str::uuid(),
                'user_id' => $user->id,
                'kind' => 'source',
                'source_name' => $name,
                'source_path' => $path,
                'status' => AiJob::STATUS_QUEUED,
                'stage' => 'extracting',
                'total' => count($chunks),
                'estimated_micros' => $estimate,
                'reserved_micros' => $estimate,
            ]);
        });

        GenerateCardsJob::dispatch($job);

        return $this->created($this->present($job));
    }

    public function show(Request $request, AiJob $job): JsonResponse
    {
        $this->mine($request, $job);

        return $this->ok($this->present($job));
    }

    /**
     * The suggestions, worst-graded last.
     *
     * Only what survived grading is here at all — T0 and T1 were dropped before
     * this table was written, because a wall of sixty pre-ticked cards *is* the
     * rubber stamp the approval screen exists to prevent.
     */
    public function candidates(Request $request, AiJob $job): JsonResponse
    {
        $this->mine($request, $job);

        $rows = $job->candidates()
            ->where('status', AiCandidate::STATUS_PENDING)
            ->orderByDesc('tier')
            ->orderBy('created_at')
            ->limit(500)
            ->get();

        return $this->ok([
            'candidates' => $rows->map(fn (AiCandidate $c): array => [
                'id' => $c->id,
                'note_type' => $c->note_type,
                'fields' => $c->fields,
                'tags' => $c->tags,
                'tier' => $c->tier,
                'dimension' => $c->dimension,
                'reason' => $c->grade_reason,
                'source_excerpt' => $c->source_excerpt,
            ])->values()->all(),
        ]);
    }

    /**
     * Keep these ones.
     *
     * Returns note data rather than writing notes: the collection is on the
     * device. The client writes them through its ordinary note path, so they
     * get real GUIDs, generate their cards the normal way, bury siblings, sync
     * and export like anything else. If this ever grew its own insert, the
     * breakage would show up months later as duplicates after an Anki import.
     */
    public function accept(Request $request, AiJob $job): JsonResponse
    {
        $this->mine($request, $job);

        $data = $request->validate([
            'ids' => ['required', 'array', 'min:1', 'max:500'],
            'ids.*' => ['string'],
        ]);

        $rows = $job->candidates()
            ->whereIn('id', $data['ids'])
            ->where('status', AiCandidate::STATUS_PENDING)
            ->get();

        AiCandidate::query()
            ->whereIn('id', $rows->pluck('id'))
            ->update(['status' => AiCandidate::STATUS_ACCEPTED]);

        // Everything not accepted in this call is rejected, because the screen
        // is default-reject and leaving them pending would mean a second visit
        // silently re-offers cards somebody already passed over.
        $job->candidates()
            ->where('status', AiCandidate::STATUS_PENDING)
            ->update(['status' => AiCandidate::STATUS_REJECTED]);

        return $this->ok([
            'notes' => $rows->map(fn (AiCandidate $c): array => [
                'note_type' => $c->note_type,
                'fields' => $c->fields,
                'tags' => $c->tags,
            ])->values()->all(),
        ]);
    }

    /** Abandon a run and take the upload with it. */
    public function destroy(Request $request, AiJob $job): JsonResponse
    {
        $this->mine($request, $job);

        if ($job->source_path) {
            Storage::delete($job->source_path);
        }

        $job->delete();

        return $this->ok(['deleted' => true]);
    }

    /**
     * Roughly what a document will cost, from its chunk count.
     *
     * Deliberately generous. The reservation is a ceiling, not a forecast — a
     * job that overruns stops and reports partial results, and the honest
     * failure is refusing a document that would have fit, not spending past an
     * allowance somebody was told they had.
     */
    private function estimate(int $chunks): int
    {
        // ~$0.065 per chunk: one generation call on the expensive model plus
        // its grading pass on the cheap one, with room.
        return $chunks * 65_000;
    }

    private function mine(Request $request, AiJob $job): void
    {
        if ($job->user_id !== $request->user()->id) {
            throw new ApiException(ApiErrorCode::NotFound, 'No such job.');
        }
    }

    /** @return array<string, mixed> */
    private function present(AiJob $job): array
    {
        return [
            'id' => $job->id,
            'source_name' => $job->source_name,
            'status' => $job->status,
            'stage' => $job->stage,
            'done' => $job->done,
            'total' => $job->total,
            'estimated_micros' => $job->estimated_micros,
            'error' => $job->error,
            'candidates' => $job->candidates()->where('status', AiCandidate::STATUS_PENDING)->count(),
        ];
    }
}
