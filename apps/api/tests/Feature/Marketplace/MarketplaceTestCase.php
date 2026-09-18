<?php

declare(strict_types=1);

namespace Tests\Feature\Marketplace;

use App\Contracts\Repositories\ListingRepository;
use App\Models\Deck;
use App\Models\Listing;
use App\Models\Note;
use App\Models\NoteType;
use App\Models\User;
use App\Repositories\Eloquent\EloquentListingRepository;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use App\Services\Marketplace\ModerationService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * Shared setup for the marketplace tests: accounts, a deck worth publishing, and
 * the two-step publish (a first-time publisher waits on a moderator).
 */
abstract class MarketplaceTestCase extends TestCase
{
    use RefreshDatabase;

    protected const PASSWORD = 'thoracic-aorta-lecture-notes';

    protected function setUp(): void
    {
        parent::setUp();

        // Until RepositoryServiceProvider carries this binding — reported as a
        // wiring change, since that file is not this agent's to edit.
        $this->app->bind(ListingRepository::class, EloquentListingRepository::class);
    }

    /**
     * Drop the bearer token from the next request.
     *
     * `withHeader()` persists for the whole test *and* the guard memoises the
     * user it resolved first (see TestCase::actingAsToken), so a public route
     * tested after a signed-in call is silently tested as that user — which is
     * how a "strangers cannot see this" assertion passes while strangers can.
     */
    protected function anonymous(): static
    {
        Auth::forgetGuards();

        return $this->flushHeaders();
    }

    protected function account(bool $verified = true, bool $moderator = false): User
    {
        $user = User::factory()
            ->when(! $verified, fn ($factory) => $factory->unverified())
            ->create(['password' => self::PASSWORD]);

        if ($moderator) {
            $user->forceFill(['is_moderator' => true])->save();
        }

        return $user;
    }

    protected function tokenFor(User $user): string
    {
        return app(AuthService::class)
            ->login($user->email, self::PASSWORD, new DeviceIdentity('iPhone'))['token']
            ->plainTextToken;
    }

    /** A deck with a note type and two notes, which is enough to publish. */
    protected function deckWithNotes(User $owner, string $name = 'Anatomy', int $notes = 2): Deck
    {
        $deck = Deck::query()->create([
            'id' => (string) Str::uuid(),
            'user_id' => $owner->id,
            'name' => $name,
            'revision' => 1,
            'client_updated_at' => 1_700_000_000_000,
        ]);

        $type = NoteType::query()->create([
            'id' => (string) Str::uuid(),
            'user_id' => $owner->id,
            'name' => 'Basic',
            'fields' => ['Front', 'Back'],
            'templates' => [['name' => 'Card 1', 'qfmt' => '{{Front}}', 'afmt' => '{{Back}}']],
            'css' => '',
            'field_config' => [],
            'anki_extra' => [],
            'revision' => 2,
            'client_updated_at' => 1_700_000_000_000,
        ]);

        for ($i = 0; $i < $notes; $i++) {
            Note::query()->create([
                'id' => (string) Str::uuid(),
                'user_id' => $owner->id,
                // Unique per deck: `notes` is unique on (user_id, guid), which is
                // the very constraint the clone-guid derivation exists to respect.
                'guid' => substr(md5($deck->id.':'.$i), 0, 16),
                'note_type_id' => $type->id,
                'deck_id' => $deck->id,
                'fields' => ['Aorta '.$i, 'Largest artery'],
                'tags' => 'anatomy thorax',
                'revision' => 3 + $i,
                'client_updated_at' => 1_700_000_000_000,
            ]);
        }

        return $deck;
    }

    /**
     * @param  array<string, mixed>  $overrides
     * @return array<string, mixed>
     */
    protected function publishBody(Deck $deck, array $overrides = []): array
    {
        return [
            'deck_id' => $deck->id,
            'title' => 'Thoracic anatomy',
            'description' => 'Vessels of the thorax, drawn from lectures.',
            'tags' => ['anatomy', 'thorax'],
            'visibility' => Listing::VISIBILITY_PUBLIC,
            'rights_attestation' => 'own_work',
            ...$overrides,
        ];
    }

    /**
     * Publish and get it past the first-publication review, which is the state
     * most of these tests actually want to start from.
     *
     * @param  array<string, mixed>  $overrides
     */
    protected function publishedListing(User $publisher, Deck $deck, array $overrides = []): Listing
    {
        $this->actingAsToken($this->tokenFor($publisher))
            ->postJson(route('marketplace.listings.store'), $this->publishBody($deck, $overrides))
            ->assertCreated();

        $listing = Listing::query()->where('deck_id', $deck->id)->firstOrFail();

        if ($listing->status !== Listing::STATUS_PUBLISHED) {
            app(ModerationService::class)->approve($this->account(moderator: true), $listing);
        }

        return $listing->refresh();
    }
}
