<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Jobs\GenerateCardsJob;
use App\Models\AiCandidate;
use App\Models\AiJob;
use App\Models\User;
use App\Services\Ai\GenerateService;
use App\Services\Ai\Ledger;
use App\Services\Ai\SourceText;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * Source text into cards somebody chose to keep.
 *
 * The model's taste is not testable here. What is testable, and is where this
 * feature would fail quietly, is the shape around it: **a card the grader
 * rejected must never reach the approval screen**, the upload must be deleted
 * whichever way the job ended, and acceptance must hand back ordinary note data
 * rather than inventing a second kind of note.
 */
class AiPipelineTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    /** Two paragraphs, long enough to chunk and to be worth prompts. */
    private const SOURCE = <<<'TXT'
    The mitral valve lies between the left atrium and the left ventricle. It has
    two cusps, which is where its other name, the bicuspid valve, comes from. It
    closes during ventricular systole to stop blood returning to the atrium, and
    the sound of that closure is the first heart sound.

    The tricuspid valve sits on the right side of the heart, between the right
    atrium and the right ventricle, and has three cusps. Its failure produces a
    murmur that is loudest at the lower left sternal border, and it is heard
    best during inspiration because venous return to the right heart rises.
    TXT;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.key' => 'test-key']);
        Storage::fake();
    }

    // ── chunking, which decides whether the cards are any good ────────────

    public function test_chunking_keeps_sentences_whole(): void
    {
        // A chunk cut mid-clause produces exactly the "fragment of a fact"
        // card the grader is built to reject — so the cutting is worth a test
        // of its own, without a model involved.
        $chunks = app(SourceText::class)->chunks(str_repeat(self::SOURCE."\n\n", 12));

        $this->assertGreaterThan(1, count($chunks), 'a long document is split');
        foreach ($chunks as $chunk) {
            $this->assertNotEmpty(trim($chunk));
            $this->assertLessThanOrEqual(SourceText::CHUNK + SourceText::OVERLAP, mb_strlen($chunk));
            // The cut lands on a sentence end, never mid-clause: a chunk that
            // starts halfway through a sentence is where fragment cards come
            // from, and the grader would (correctly) reject the lot.
            $this->assertMatchesRegularExpression('/[.!?]$/u', trim($chunk), 'chunks end on a sentence');
        }
    }

    public function test_a_document_with_nothing_in_it_is_refused_before_it_costs_anything(): void
    {
        Http::fake();
        $token = $this->tokenFor($this->consentingAccount());

        $this->actingAsToken($token)
            ->post(route('ai.jobs.store'), [
                'file' => UploadedFile::fake()->createWithContent('empty.txt', 'too short'),
            ], ['Accept' => 'application/json'])
            ->assertStatus(422);

        Http::assertNothingSent();
        $this->assertSame(0, AiJob::query()->count());
    }

    // ── the run ───────────────────────────────────────────────────────────

    public function test_an_upload_returns_an_estimate_before_anything_runs(): void
    {
        // "This will use about a fifth of your month" is the only honest way to
        // let somebody decide, and it has to arrive before the spending does.
        Queue::fake();
        $token = $this->tokenFor($this->consentingAccount());

        $response = $this->actingAsToken($token)
            ->post(route('ai.jobs.store'), ['file' => $this->sourceFile()], ['Accept' => 'application/json'])
            ->assertStatus(201)
            ->assertJsonPath('data.status', 'queued');

        $this->assertGreaterThan(0, $response->json('data.estimated_micros'));
        $this->assertGreaterThan(0, $response->json('data.total'));
        Queue::assertPushed(GenerateCardsJob::class);
    }

    public function test_a_document_beyond_the_allowance_is_refused(): void
    {
        Queue::fake();
        config(['ai.plans.free.limit_micros' => 1]);

        $this->actingAsToken($this->tokenFor($this->consentingAccount()))
            ->post(route('ai.jobs.store'), ['file' => $this->sourceFile()], ['Accept' => 'application/json'])
            ->assertStatus(402)
            ->assertJsonPath('error.code', 'ai_quota_exceeded');

        Queue::assertNothingPushed();
    }

    public function test_only_one_run_at_a_time(): void
    {
        // Four jobs in flight all back off together on a 429 and stampede when
        // they wake.
        Queue::fake();
        $token = $this->tokenFor($this->consentingAccount());

        $this->actingAsToken($token)
            ->post(route('ai.jobs.store'), ['file' => $this->sourceFile()], ['Accept' => 'application/json'])
            ->assertStatus(201);

        $this->actingAsToken($token)
            ->post(route('ai.jobs.store'), ['file' => $this->sourceFile()], ['Accept' => 'application/json'])
            ->assertStatus(422);
    }

    public function test_the_grader_drops_weak_cards_before_the_approval_screen(): void
    {
        // The whole design. 36% of frontier-model cards are unusable and the
        // unusable ones look fine, so a human skimming sixty suggestions cannot
        // be the filter — the grader has to be.
        $user = $this->consentingAccount();
        $this->fakePipeline(
            cards: [
                ['front' => 'Which valve is between the left atrium and ventricle?', 'back' => 'The mitral valve'],
                ['front' => 'What does it do?', 'back' => 'Closes'],
            ],
            verdicts: [
                ['id' => '0', 'tier' => 3, 'dimension' => 'ok', 'reason' => ''],
                ['id' => '1', 'tier' => 1, 'dimension' => 'lacks_context', 'reason' => 'Ambiguous on its own.'],
            ],
        );

        $job = $this->runJob($user);

        $this->assertSame(AiJob::STATUS_DONE, $job->status);
        $kept = $job->candidates()->get();
        $this->assertCount(1, $kept, 'the T1 card never reaches the screen');
        $this->assertSame('Which valve is between the left atrium and ventricle?', $kept->first()->fields['Front']);
    }

    public function test_the_upload_is_deleted_when_the_job_ends(): void
    {
        // Source material is the most sensitive content in the product and has
        // no reason to outlive the job that read it.
        $user = $this->consentingAccount();
        $this->fakePipeline(
            cards: [['front' => 'a', 'back' => 'b']],
            verdicts: [['id' => '0', 'tier' => 3, 'dimension' => 'ok', 'reason' => '']],
        );

        $job = $this->runJob($user);

        $this->assertNull($job->source_path);
    }

    public function test_the_same_card_twice_is_stored_once(): void
    {
        $user = $this->consentingAccount();
        $this->fakePipeline(
            cards: [
                ['front' => 'Which valve?', 'back' => 'Mitral'],
                ['front' => 'which   VALVE?', 'back' => 'mitral'],
            ],
            verdicts: [
                ['id' => '0', 'tier' => 3, 'dimension' => 'ok', 'reason' => ''],
                ['id' => '1', 'tier' => 3, 'dimension' => 'ok', 'reason' => ''],
            ],
        );

        $job = $this->runJob($user);

        $this->assertSame(1, $job->candidates()->count(), 'normalised, so spacing and case do not duplicate');
    }

    // ── accepting ─────────────────────────────────────────────────────────

    public function test_accepting_returns_notes_and_rejects_the_rest(): void
    {
        $user = $this->consentingAccount();
        $this->fakePipeline(
            cards: [
                ['front' => 'Which valve is between the left atrium and ventricle?', 'back' => 'Mitral', 'tags' => ['anatomy']],
                ['front' => 'How many cusps has the tricuspid valve?', 'back' => 'Three'],
            ],
            verdicts: [
                ['id' => '0', 'tier' => 3, 'dimension' => 'ok', 'reason' => ''],
                ['id' => '1', 'tier' => 3, 'dimension' => 'ok', 'reason' => ''],
            ],
        );

        $job = $this->runJob($user);
        $keep = $job->candidates()->first();

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.jobs.accept', $job), ['ids' => [$keep->id]])
            ->assertOk()
            ->assertJsonCount(1, 'data.notes')
            ->assertJsonPath('data.notes.0.fields.Front', $keep->fields['Front']);

        // Default-reject: what was not kept in this pass is not offered again.
        $this->assertSame(0, $job->candidates()->where('status', AiCandidate::STATUS_PENDING)->count());
        $this->assertSame(1, $job->candidates()->where('status', AiCandidate::STATUS_REJECTED)->count());
    }

    public function test_a_job_belongs_to_one_account(): void
    {
        Queue::fake();
        $mine = $this->consentingAccount();

        $this->actingAsToken($this->tokenFor($mine))
            ->post(route('ai.jobs.store'), ['file' => $this->sourceFile()], ['Accept' => 'application/json']);

        $job = AiJob::query()->sole();

        $this->actingAsToken($this->tokenFor($this->consentingAccount()))
            ->getJson(route('ai.jobs.show', $job))
            ->assertStatus(404);
    }

    // ── fixtures ──────────────────────────────────────────────────────────

    private function sourceFile(): UploadedFile
    {
        return UploadedFile::fake()->createWithContent('lecture.txt', self::SOURCE);
    }

    /** Run a job end to end, synchronously. */
    private function runJob(User $user): AiJob
    {
        $path = 'ai/'.$user->id.'/source.txt';
        Storage::put($path, self::SOURCE);

        $job = AiJob::query()->create([
            'id' => (string) Str::uuid(),
            'user_id' => $user->id,
            'kind' => 'source',
            'source_name' => 'lecture.txt',
            'source_path' => $path,
            'status' => AiJob::STATUS_QUEUED,
            'stage' => 'extracting',
            'estimated_micros' => 200_000,
            'reserved_micros' => 200_000,
        ]);

        app(GenerateCardsJob::class, ['aiJob' => $job])->handle(
            app(SourceText::class),
            app(GenerateService::class),
            app(Ledger::class),
        );

        return $job->fresh();
    }

    /**
     * Generation answers first, then grading — the two calls the pipeline makes
     * per chunk, in order.
     *
     * @param  list<array<string, mixed>>  $cards
     * @param  list<array<string, mixed>>  $verdicts
     */
    private function fakePipeline(array $cards, array $verdicts): void
    {
        $generate = [
            'id' => 'msg_gen', 'stop_reason' => 'end_turn',
            'content' => [['type' => 'tool_use', 'name' => 'cards', 'input' => ['cards' => $cards]]],
            'usage' => ['input_tokens' => 1200, 'output_tokens' => 400],
        ];

        $grade = [
            'id' => 'msg_grade', 'stop_reason' => 'end_turn',
            'content' => [['type' => 'tool_use', 'name' => 'verdicts', 'input' => ['verdicts' => $verdicts]]],
            'usage' => ['input_tokens' => 600, 'output_tokens' => 150],
        ];

        // The two calls one chunk makes, in order. `whenEmpty` covers a source
        // that chunked into more than one piece.
        Http::fakeSequence()
            ->push($generate, 200)
            ->push($grade, 200)
            ->whenEmpty(Http::response($grade, 200));
    }

    private function consentingAccount(): User
    {
        $user = User::factory()->create(['password' => self::PASSWORD]);
        $user->forceFill(['ai_consent_at' => now()])->save();

        return $user->fresh();
    }

    private function tokenFor(User $user): string
    {
        return app(AuthService::class)
            ->login($user->email, self::PASSWORD, new DeviceIdentity('iPhone'))['token']
            ->plainTextToken;
    }
}
