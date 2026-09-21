<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Enums\AiFeature;
use App\Exceptions\ApiException;
use App\Models\AiJob;
use App\Models\AiUsage;
use App\Models\User;
use App\Services\Ai\Claude;
use App\Services\Ai\Ledger;
use App\Services\Ai\Pricing;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * The meter.
 *
 * Every failure AI.md §6 names is arithmetic or ordering, not network — so
 * every test here asserts an exact number against a faked response, and none of
 * them reaches Anthropic. The rule the whole phase rests on is the one asserted
 * most often: **a call cannot happen without a ledger row**, including the
 * calls that fail.
 *
 * Phase 8 shipped three contract bugs whose tests passed, because the tests
 * asserted that *something* was there rather than what it was
 * (`assertCount(2, 'preview')` on an object with two keys). So these assert the
 * arithmetic.
 */
class AiLedgerTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.key' => 'test-key']);
    }

    // ── the arithmetic ────────────────────────────────────────────────────

    public function test_cost_counts_cache_tokens_separately_from_input(): void
    {
        // AI.md §6.5, hand-computed against the Opus 5 table ($5/M in,
        // $25/M out), where a cache write is 1.25× input and a read is 0.10×:
        //
        //   input       1000 × 5.00 =  5,000
        //   cache write 2000 × 6.25 = 12,500
        //   cache read  4000 × 0.50 =  2,000
        //   output       500 × 25.0 = 12,500
        //                             ------
        //                             32,000 micro-dollars
        //
        // `usage.input_tokens` EXCLUDES the two cache counts. Adding them to it
        // double-charges; dropping them under-charges a cached workload by most
        // of its bill. Both are silent.
        $this->assertSame(
            32_000,
            Pricing::cost('claude-opus-5', 1000, 2000, 4000, 500),
        );
    }

    public function test_the_ordinary_uncached_call_is_just_input_plus_output(): void
    {
        // 1000 × 5 + 500 × 25 = 17,500
        $this->assertSame(17_500, Pricing::cost('claude-opus-5', 1000, 0, 0, 500));
    }

    public function test_the_cheaper_model_is_cheaper_by_exactly_its_table(): void
    {
        // Haiku at $1/M in, $5/M out: 1000 × 1 + 500 × 5 = 3,500.
        $this->assertSame(3_500, Pricing::cost('claude-haiku-4-5-20251001', 1000, 0, 0, 500));
    }

    public function test_an_unpriced_model_still_records_the_call_at_zero(): void
    {
        // A model missing from the price table is a deploy that has not caught
        // up, not a reason to lose the row: the tokens are kept and the cost can
        // be recomputed. Silently skipping the row is the worse outcome.
        $this->assertSame(0, Pricing::cost('claude-from-the-future', 1000, 0, 0, 500));
    }

    // ── one call, one row ─────────────────────────────────────────────────

    public function test_a_successful_call_writes_exactly_one_row_with_the_real_numbers(): void
    {
        $user = $this->consentingAccount();
        $this->fakeAnthropic(['input_tokens' => 1000, 'output_tokens' => 500]);

        app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);

        $row = AiUsage::query()->sole();
        $this->assertSame('explain', $row->feature);
        $this->assertSame('ok', $row->status);
        $this->assertSame(1000, $row->input_tokens);
        $this->assertSame(500, $row->output_tokens);
        $this->assertSame(17_500, $row->cost_micros);
        $this->assertSame(config('ai.price_version'), $row->price_version);
    }

    public function test_a_refusal_is_a_200_and_must_still_be_billed(): void
    {
        // The trap: `stop_reason: refusal` is an HTTP 200 with nothing usable.
        // Recording only successes under-reports the bill by exactly the calls
        // most worth looking at.
        $user = $this->consentingAccount();
        $this->fakeAnthropic(['input_tokens' => 800, 'output_tokens' => 10], stopReason: 'refusal');

        try {
            app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);
            $this->fail('a refusal must surface to the caller');
        } catch (ApiException $e) {
            $this->assertSame('ai_refused', $e->errorCode->value);
        }

        $row = AiUsage::query()->sole();
        $this->assertSame('refusal', $row->status);
        $this->assertSame(800, $row->input_tokens);
        $this->assertGreaterThan(0, $row->cost_micros, 'a refusal is charged for');
    }

    public function test_a_truncated_answer_is_recorded_as_truncated_at_full_price(): void
    {
        $user = $this->consentingAccount();
        $this->fakeAnthropic(['input_tokens' => 100, 'output_tokens' => 1024], stopReason: 'max_tokens');

        app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);

        $this->assertSame('truncated', AiUsage::query()->sole()->status);
    }

    public function test_an_upstream_failure_still_leaves_a_row(): void
    {
        $user = $this->consentingAccount();
        Http::fake(['*' => Http::response(['error' => ['message' => 'overloaded']], 529)]);

        try {
            app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);
            $this->fail('an upstream failure must surface');
        } catch (ApiException $e) {
            $this->assertSame('ai_upstream', $e->errorCode->value);
        }

        $this->assertSame('error', AiUsage::query()->sole()->status);
    }

    // ── the quota ─────────────────────────────────────────────────────────

    public function test_spend_is_summed_from_the_log_rather_than_counted(): void
    {
        $user = $this->consentingAccount();
        $this->fakeAnthropic(['input_tokens' => 1000, 'output_tokens' => 500]);

        foreach (range(1, 3) as $ignored) {
            app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);
        }

        // Three identical calls at 17,500 each. There is no counter to drift.
        $this->assertSame(52_500, app(Ledger::class)->spent($user));
    }

    public function test_a_call_is_refused_once_the_allowance_is_gone(): void
    {
        $user = $this->consentingAccount();
        config(['ai.plans.free.limit_micros' => 20_000]);
        $this->fakeAnthropic(['input_tokens' => 1000, 'output_tokens' => 500]);

        // 17,500 spent, 2,500 left — less than the 12,000 the next call
        // estimates, so the check must refuse before the wire, not after.
        app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);

        try {
            app(Claude::class)->call(
                $user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']],
                estimateMicros: 12_000,
            );
            $this->fail('the second call must be refused');
        } catch (ApiException $e) {
            $this->assertSame('ai_quota_exceeded', $e->errorCode->value);
        }

        $this->assertSame(1, AiUsage::query()->count(), 'a refused call never reached the API');
    }

    // ── the guardrails around concurrency ─────────────────────────────────

    public function test_money_promised_to_a_queued_job_is_not_offered_twice(): void
    {
        // The hole this closes: `reserved_micros` was written at dispatch and
        // read by nothing. A document costing almost the whole allowance would
        // sit in the queue while an interactive call was told the allowance was
        // untouched — and then the job overran the month.
        $user = $this->consentingAccount();
        config(['ai.plans.free.limit_micros' => 30_000]);
        $this->fakeAnthropic(['input_tokens' => 1000, 'output_tokens' => 500]);

        $this->queuedJob($user, reserved: 25_000);

        $this->assertSame(25_000, app(Ledger::class)->reserved($user));
        $this->assertSame(5_000, app(Ledger::class)->remaining($user));

        try {
            app(Claude::class)->call(
                $user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']],
                estimateMicros: 12_000,
            );
            $this->fail('a call larger than the unreserved remainder must be refused');
        } catch (ApiException $e) {
            $this->assertSame('ai_quota_exceeded', $e->errorCode->value);
        }

        Http::assertNothingSent();
    }

    public function test_a_job_may_spend_the_money_it_reserved(): void
    {
        // Without the exemption a document whose estimate used the last of an
        // allowance would reserve itself into a deadlock and never make its
        // first call — the guardrail eating the thing it was guarding.
        $user = $this->consentingAccount();
        config(['ai.plans.free.limit_micros' => 30_000]);
        $this->fakeAnthropic(['input_tokens' => 1000, 'output_tokens' => 500]);

        $job = $this->queuedJob($user, reserved: 30_000);

        app(Claude::class)->call(
            $user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']],
            jobId: $job->id, estimateMicros: 12_000,
        );

        $this->assertSame(1, AiUsage::query()->count());
    }

    public function test_a_reservation_shrinks_as_its_job_actually_spends(): void
    {
        // Counted twice, a running job would halve the allowance in the middle
        // of the work it was reserved for.
        $user = $this->consentingAccount();
        $job = $this->queuedJob($user, reserved: 30_000);
        $this->fakeAnthropic(['input_tokens' => 1000, 'output_tokens' => 500]);

        app(Claude::class)->call(
            $user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']],
            jobId: $job->id,
        );

        // 17,500 of the 30,000 is now real spend, so 12,500 is still promised.
        $this->assertSame(17_500, app(Ledger::class)->spent($user));
        $this->assertSame(12_500, app(Ledger::class)->reserved($user));
    }

    public function test_a_finished_job_stops_holding_its_reservation(): void
    {
        // Released by status rather than by a completion hook: a reservation
        // that has to be handed back leaks the first time a worker dies, and
        // the leak looks exactly like ordinary spending.
        $user = $this->consentingAccount();
        $job = $this->queuedJob($user, reserved: 25_000);

        $this->assertSame(25_000, app(Ledger::class)->reserved($user));

        $job->update(['status' => AiJob::STATUS_DONE]);

        $this->assertSame(0, app(Ledger::class)->reserved($user->fresh()));
    }

    public function test_one_call_at_a_time_per_account(): void
    {
        // `canSpend` is a read and the charge it authorises lands a second
        // later, so two simultaneous requests are both told the same dollar is
        // theirs. The lock makes the check and the charge one operation.
        $user = $this->consentingAccount();
        Http::fake();

        $held = Cache::lock("ai:call:{$user->id}", 120);
        $this->assertTrue($held->get(), 'the first caller takes the lock');

        try {
            app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);
            $this->fail('a second simultaneous call must be refused');
        } catch (ApiException $e) {
            $this->assertSame('rate_limited', $e->errorCode->value);
        } finally {
            $held->release();
        }

        Http::assertNothingSent();
        $this->assertSame(0, AiUsage::query()->count(), 'a refused call never reached the API');
    }

    public function test_the_lock_is_released_when_a_call_fails(): void
    {
        // A lock held by a call that threw would lock the account out of its
        // own allowance for two minutes.
        $user = $this->consentingAccount();
        Http::fake(['*' => Http::response(['error' => 'boom'], 500)]);

        try {
            app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);
        } catch (ApiException) {
            // expected — the point is what happens to the lock.
        }

        $next = Cache::lock("ai:call:{$user->id}", 120);
        $this->assertTrue($next->get(), 'the lock did not outlive the failed call');
        $next->release();
    }

    public function test_the_period_start_is_stored_once_and_not_recomputed(): void
    {
        // A window derived from `now()` on each request grants a second
        // allowance across one DST boundary and denies one across the other.
        $user = $this->consentingAccount();
        $ledger = app(Ledger::class);

        $first = $ledger->periodStart($user);
        $this->travel(3)->days();
        $this->assertTrue($first->equalTo($ledger->periodStart($user->fresh())));
    }

    // ── consent and configuration ─────────────────────────────────────────

    public function test_nothing_is_sent_without_consent(): void
    {
        $user = $this->account();          // no ai_consent_at
        Http::fake();

        try {
            app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);
            $this->fail('consent is required');
        } catch (ApiException $e) {
            $this->assertSame('ai_consent_required', $e->errorCode->value);
        }

        Http::assertNothingSent();
        $this->assertSame(0, AiUsage::query()->count());
    }

    public function test_without_a_key_the_feature_is_absent_rather_than_broken(): void
    {
        config(['ai.key' => null]);
        $this->assertFalse(Claude::configured());

        $user = $this->consentingAccount();
        Http::fake();

        try {
            app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);
            $this->fail('an unconfigured server must say so');
        } catch (ApiException $e) {
            $this->assertSame('ai_unavailable', $e->errorCode->value);
        }

        Http::assertNothingSent();
    }

    // ── the endpoints ─────────────────────────────────────────────────────

    public function test_usage_reports_the_period_and_the_split_by_feature(): void
    {
        $user = $this->consentingAccount();
        $this->fakeAnthropic(['input_tokens' => 1000, 'output_tokens' => 500]);
        app(Claude::class)->call($user, AiFeature::Explain, 'sys', [['role' => 'user', 'content' => 'hi']]);

        $this->actingAsToken($this->tokenFor($user))
            ->getJson(route('ai.usage'))
            ->assertOk()
            ->assertJsonPath('data.spent_micros', 17_500)
            ->assertJsonPath('data.by_feature.explain.calls', 1)
            ->assertJsonPath('data.by_feature.explain.micros', 17_500)
            // Tokens as well as dollars: a price change reprices history, and
            // "how much did I send" is the question that still has the same
            // answer afterwards.
            ->assertJsonPath('data.tokens.input', 1000)
            ->assertJsonPath('data.tokens.output', 500)
            ->assertJsonPath('data.by_feature.explain.tokens.input', 1000)
            ->assertJsonPath('data.reserved_micros', 0)
            ->assertJsonPath('data.consented', true);
    }

    public function test_consent_can_be_given_and_taken_back(): void
    {
        $user = $this->account();
        $token = $this->tokenFor($user);

        $this->actingAsToken($token)
            ->putJson(route('ai.consent'), ['enabled' => true])
            ->assertOk()
            ->assertJsonPath('data.consented', true);

        $this->actingAsToken($token)
            ->putJson(route('ai.consent'), ['enabled' => false])
            ->assertOk()
            ->assertJsonPath('data.consented', false);

        $this->assertNull($user->fresh()->ai_consent_at);
    }

    public function test_explain_returns_the_two_strings_and_nothing_else(): void
    {
        $user = $this->consentingAccount();
        $this->fakeAnthropic(
            ['input_tokens' => 400, 'output_tokens' => 120],
            tool: ['explanation' => 'The mitral valve is between the left atrium and ventricle.',
                'confusable_with' => 'The tricuspid valve, which sits on the right.'],
        );

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.explain'), [
                'fields' => ['Front' => 'Mitral valve', 'Back' => '<b>Left</b> AV valve'],
                'deck' => 'Thorax',
                'lapses' => 4,
            ])
            ->assertOk()
            ->assertJsonPath('data.explanation', 'The mitral valve is between the left atrium and ventricle.')
            ->assertJsonPath('data.confusable_with', 'The tricuspid valve, which sits on the right.');
    }

    public function test_the_card_is_sent_as_data_with_its_markup_stripped(): void
    {
        // The field could have arrived from an imported Anki deck or a cloned
        // marketplace listing — content this user did not write. It goes in a
        // user turn, fenced, with its HTML removed; the system prompt carries
        // instructions and never carries it.
        $user = $this->consentingAccount();
        $this->fakeAnthropic(['input_tokens' => 10, 'output_tokens' => 10], tool: ['explanation' => 'x', 'confusable_with' => 'y']);

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.explain'), [
                'fields' => ['Front' => '<img src=x onerror=alert(1)>Mitral <b>valve</b>'],
                'deck' => 'Thorax',
            ])
            ->assertOk();

        Http::assertSent(function ($request) {
            $body = $request->data();
            $content = $body['messages'][0]['content'];

            $this->assertSame('user', $body['messages'][0]['role'], 'card content is a user turn');
            $this->assertStringNotContainsString('<img', $content, 'markup is stripped');
            $this->assertStringNotContainsString('onerror', $content);
            $this->assertStringContainsString('Mitral valve', $content);
            $this->assertStringNotContainsString('Mitral', $body['system'], 'never in the system prompt');

            return true;
        });
    }

    public function test_the_endpoints_are_closed_to_strangers(): void
    {
        $this->getJson(route('ai.usage'))->assertStatus(401);
        $this->postJson(route('ai.explain'), ['fields' => ['a' => 'b']])->assertStatus(401);
    }

    // ── fixtures ──────────────────────────────────────────────────────────

    /**
     * @param  array<string, int>  $usage
     * @param  array<string, string>|null  $tool
     */
    private function fakeAnthropic(array $usage, ?string $stopReason = 'end_turn', ?array $tool = null): void
    {
        $content = $tool !== null
            ? [['type' => 'tool_use', 'name' => 'answer', 'input' => $tool]]
            : [['type' => 'text', 'text' => 'ok']];

        Http::fake(['*' => Http::response([
            'id' => 'msg_test',
            'stop_reason' => $stopReason,
            'content' => $content,
            'usage' => $usage,
        ], 200)]);
    }

    private function queuedJob(User $user, int $reserved): AiJob
    {
        return AiJob::query()->create([
            'id' => (string) Str::uuid(),
            'user_id' => $user->id,
            'kind' => 'source',
            'source_name' => 'lecture.pdf',
            'status' => AiJob::STATUS_QUEUED,
            'stage' => 'extracting',
            'total' => 8,
            'estimated_micros' => $reserved,
            'reserved_micros' => $reserved,
        ]);
    }

    private function account(): User
    {
        return User::factory()->create(['password' => self::PASSWORD]);
    }

    private function consentingAccount(): User
    {
        $user = $this->account();
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
