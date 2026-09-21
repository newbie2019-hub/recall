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
 * The rewrite suggestion.
 *
 * Whether the prose is any good is not testable here. What is testable is
 * everything that decides whether a bad answer can do damage: a field name the
 * model invented must not reach the client, markup must not survive the return
 * leg, an unchanged field must not arrive as a suggestion, and the call must
 * be on the meter like every other one.
 */
class AiRewriteTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.key' => 'test-key']);
    }

    public function test_it_returns_only_the_fields_it_changed(): void
    {
        $user = $this->consentingAccount();
        $this->fakeSuggestion([
            ['name' => 'Front', 'text' => 'Which valve separates the left atrium from the left ventricle?'],
            // Identical to what was sent: not a suggestion, and an "accept"
            // button on a box nothing happened to is a lie about the diff.
            ['name' => 'Back', 'text' => 'Mitral valve'],
        ], 'Named the chambers so the question has one answer.');

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.rewrite'), ['fields' => [
                'Front' => 'The valve',
                'Back' => 'Mitral valve',
            ]])
            ->assertOk()
            ->assertJsonPath('data.fields.Front', 'Which valve separates the left atrium from the left ventricle?')
            ->assertJsonMissingPath('data.fields.Back')
            ->assertJsonPath('data.note', 'Named the chambers so the question has one answer.');
    }

    public function test_a_field_the_model_invented_is_dropped(): void
    {
        // The client maps these straight onto boxes on screen. A name that was
        // never sent has no box to land in, and a note type does not gain a
        // field because a model mentioned one.
        $user = $this->consentingAccount();
        $this->fakeSuggestion([
            ['name' => 'Front', 'text' => 'Which valve lies between the left atrium and ventricle?'],
            ['name' => 'Extra', 'text' => 'A field nobody asked for'],
        ]);

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.rewrite'), ['fields' => ['Front' => 'The valve']])
            ->assertOk()
            ->assertJsonCount(1, 'data.fields')
            ->assertJsonMissingPath('data.fields.Extra');
    }

    public function test_markup_does_not_survive_the_return_leg(): void
    {
        // README rule 5 gives card HTML a script-less iframe *because* it is
        // untrusted; model-authored HTML is untrusted twice. The prompt forbids
        // it and the schema has no field for it, but neither of those is a
        // guarantee and this value is about to be written into a note.
        $user = $this->consentingAccount();
        $this->fakeSuggestion(
            [['name' => 'Front', 'text' => '<img src=x onerror=alert(1)>Which <b>valve</b>?']],
            '<script>alert(1)</script>Tightened the prompt.',
        );

        $response = $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.rewrite'), ['fields' => ['Front' => 'The valve']])
            ->assertOk();

        $front = $response->json('data.fields.Front');
        $this->assertStringNotContainsString('<', $front);
        $this->assertStringNotContainsString('onerror', $front);
        $this->assertStringContainsString('Which valve?', $front);
        $this->assertStringNotContainsString('<script', (string) $response->json('data.note'));
    }

    public function test_the_card_travels_as_fenced_data_with_its_markup_stripped(): void
    {
        $user = $this->consentingAccount();
        $this->fakeSuggestion([['name' => 'Front', 'text' => 'Better.']]);

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.rewrite'), [
                'fields' => ['Front' => '<img src=x onerror=alert(1)>The <b>valve</b>'],
                'note_type' => 'Basic',
                'flaw' => 'Ambiguous on its own.',
            ])
            ->assertOk();

        Http::assertSent(function ($request) {
            $body = $request->data();
            $content = $body['messages'][0]['content'];

            $this->assertSame('user', $body['messages'][0]['role']);
            $this->assertStringContainsString('<card type="Basic">', $content, 'fenced as data');
            $this->assertStringNotContainsString('onerror', $content);
            $this->assertStringNotContainsString('<img', $content);
            $this->assertStringContainsString('Ambiguous on its own.', $content);
            // User content never goes in the system prompt — the structural
            // half of the injection guard.
            $this->assertStringNotContainsString('valve', $body['system']);

            return true;
        });
    }

    public function test_it_is_metered_like_every_other_call(): void
    {
        $user = $this->consentingAccount();
        $this->fakeSuggestion([['name' => 'Front', 'text' => 'Better.']]);

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.rewrite'), ['fields' => ['Front' => 'The valve']])
            ->assertOk();

        $row = AiUsage::query()->sole();
        $this->assertSame('rewrite', $row->feature);
        $this->assertSame(config('ai.models.rewrite'), $row->model);
        $this->assertGreaterThan(0, $row->cost_micros);
        $this->assertSame(900, $row->input_tokens);
        $this->assertSame(200, $row->output_tokens);
    }

    public function test_it_needs_consent_like_every_other_call(): void
    {
        $user = User::factory()->create(['password' => self::PASSWORD]);
        Http::fake();

        $this->actingAsToken($this->tokenFor($user))
            ->postJson(route('ai.rewrite'), ['fields' => ['Front' => 'The valve']])
            ->assertStatus(403);

        Http::assertNothingSent();
    }

    /**
     * @param  list<array<string, string>>  $fields
     */
    private function fakeSuggestion(array $fields, string $note = 'Tightened the prompt.'): void
    {
        Http::fake(['*' => Http::response([
            'id' => 'msg_test',
            'stop_reason' => 'end_turn',
            'content' => [['type' => 'tool_use', 'name' => 'suggest', 'input' => [
                'fields' => $fields,
                'note' => $note,
            ]]],
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
