<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\AiUsage;
use App\Models\User;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * The card doctor.
 *
 * The model's judgement is not testable here and is not what these assert.
 * What they assert is the plumbing around it, where the failures are silent:
 * a verdict the model skipped must come back as *fine* rather than vanishing,
 * a tier outside the scale must be clamped rather than sorting into a bucket
 * that hides it, and the cards must go up as fenced data in a user turn.
 */
class AiGradeTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.key' => 'test-key']);
    }

    public function test_it_grades_a_batch_in_one_call(): void
    {
        // Twenty calls would be twenty times the overhead for the same tokens,
        // and this is meant to sweep a 20,000-card import.
        $user = $this->consentingAccount();
        $this->fakeVerdicts([
            ['id' => 'n1', 'tier' => 1, 'dimension' => 'lacks_context', 'reason' => 'Ambiguous on its own.'],
            ['id' => 'n2', 'tier' => 3, 'dimension' => 'ok', 'reason' => ''],
        ]);

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.grade'), ['cards' => [
                ['id' => 'n1', 'fields' => ['Front' => 'The valve', 'Back' => 'Mitral']],
                ['id' => 'n2', 'fields' => ['Front' => 'Left AV valve', 'Back' => 'Mitral']],
            ]])
            ->assertOk()
            ->assertJsonPath('data.verdicts.0.tier', 1)
            ->assertJsonPath('data.verdicts.0.dimension', 'lacks_context')
            ->assertJsonPath('data.verdicts.1.tier', 3);

        $this->assertSame(1, AiUsage::query()->where('feature', 'grade')->count());
    }

    public function test_a_card_the_model_skipped_comes_back_as_fine(): void
    {
        // The silent failure this guards: a dropped verdict must not read as a
        // flagged card, and must not shorten the list the client is paging.
        $user = $this->consentingAccount();
        $this->fakeVerdicts([['id' => 'n1', 'tier' => 1, 'dimension' => 'shallow', 'reason' => 'Cued.']]);

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.grade'), ['cards' => [
                ['id' => 'n1', 'fields' => ['Front' => 'a']],
                ['id' => 'n2', 'fields' => ['Front' => 'b']],
            ]])
            ->assertOk()
            ->assertJsonCount(2, 'data.verdicts')
            ->assertJsonPath('data.verdicts.1.id', 'n2')
            ->assertJsonPath('data.verdicts.1.tier', 3)
            ->assertJsonPath('data.verdicts.1.dimension', 'ok');
    }

    public function test_a_tier_outside_the_scale_is_clamped(): void
    {
        $user = $this->consentingAccount();
        $this->fakeVerdicts([['id' => 'n1', 'tier' => 99, 'dimension' => 'ok', 'reason' => '']]);

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.grade'), ['cards' => [['id' => 'n1', 'fields' => ['Front' => 'a']]]])
            ->assertOk()
            ->assertJsonPath('data.verdicts.0.tier', 3);
    }

    public function test_the_cards_travel_as_fenced_data_with_their_markup_stripped(): void
    {
        $user = $this->consentingAccount();
        $this->fakeVerdicts([['id' => 'n1', 'tier' => 3, 'dimension' => 'ok', 'reason' => '']]);

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.grade'), ['cards' => [
                ['id' => 'n1', 'fields' => ['Front' => '<img src=x onerror=alert(1)>Mitral <b>valve</b>']],
            ]])
            ->assertOk();

        Http::assertSent(function ($request) {
            $body = $request->data();
            $content = $body['messages'][0]['content'];

            $this->assertSame('user', $body['messages'][0]['role']);
            $this->assertStringContainsString('<card id="n1">', $content, 'fenced as data');
            $this->assertStringNotContainsString('onerror', $content);
            $this->assertStringNotContainsString('<img', $content);
            $this->assertStringContainsString('Mitral valve', $content);
            $this->assertStringNotContainsString('Mitral', $body['system']);

            return true;
        });
    }

    public function test_a_batch_larger_than_the_limit_is_refused(): void
    {
        $user = $this->consentingAccount();
        Http::fake();

        $cards = array_map(fn (int $i): array => ['id' => "n{$i}", 'fields' => ['Front' => 'x']], range(1, 40));

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.grade'), ['cards' => $cards])
            ->assertStatus(422);

        Http::assertNothingSent();
    }

    public function test_the_grader_uses_the_cheaper_model_and_is_still_metered(): void
    {
        // An LLM judge is the sanctioned place for a cheaper model — and it is
        // a ledger feature, not a free internal step. Unmetered grading would
        // make the number in Settings wrong by whatever grading costs.
        $user = $this->consentingAccount();
        $this->fakeVerdicts([['id' => 'n1', 'tier' => 3, 'dimension' => 'ok', 'reason' => '']]);

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.grade'), ['cards' => [['id' => 'n1', 'fields' => ['Front' => 'a']]]])
            ->assertOk();

        $row = AiUsage::query()->sole();
        $this->assertSame(config('ai.models.grade'), $row->model);
        $this->assertGreaterThan(0, $row->cost_micros);
    }

    /** @param list<array<string, mixed>> $verdicts */
    private function fakeVerdicts(array $verdicts): void
    {
        Http::fake(['*' => Http::response([
            'id' => 'msg_test',
            'stop_reason' => 'end_turn',
            'content' => [['type' => 'tool_use', 'name' => 'verdicts', 'input' => ['verdicts' => $verdicts]]],
            'usage' => ['input_tokens' => 900, 'output_tokens' => 200],
        ], 200)]);
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
