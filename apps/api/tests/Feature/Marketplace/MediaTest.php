<?php

declare(strict_types=1);

namespace Tests\Feature\Marketplace;

use App\Models\Listing;
use App\Models\MediaFile;
use App\Models\Note;
use App\Models\User;
use App\Services\Media\MediaStore;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;

/**
 * Moving the bytes.
 *
 * Two things are worth testing here and everything else is plumbing. **The hash
 * is checked**, because a store that trusts the client's name for a file lets
 * one upload poison a hash that every deck referencing it shares. And **a
 * published version serves exactly its own manifest**, because the alternative
 * — any hash the publisher happens to own — turns publishing one deck into a
 * read of a private library.
 */
class MediaTest extends MarketplaceTestCase
{
    private const PNG = "\x89PNG\r\n\x1a\ndata-for-the-test";

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake();
    }

    /**
     * `PUT /media/{sha}` with a raw body.
     *
     * Spelled out rather than using `putJson`, because the body is bytes and
     * not JSON — and `call()` does not apply the default headers that
     * `actingAsToken` sets, so the bearer travels here explicitly.
     */
    private function putBytes(string $token, string $sha, string $bytes, string $mime = 'image/png'): TestResponse
    {
        return $this->call('PUT', "/api/v1/media/{$sha}", [], [], [], [
            'CONTENT_TYPE' => $mime,
            'HTTP_ACCEPT' => 'application/json',
            'HTTP_AUTHORIZATION' => 'Bearer '.$token,
        ], $bytes);
    }

    // ── an account's own bytes ────────────────────────────────────────────

    public function test_bytes_go_up_and_come_back_down(): void
    {
        $user = $this->account();
        $token = $this->tokenFor($user);
        $sha = hash('sha256', self::PNG);

        $this->putBytes($token, $sha, self::PNG)
            ->assertStatus(201)
            ->assertJsonPath('data.sha256', $sha)
            ->assertJsonPath('data.size', strlen(self::PNG));

        $response = $this->actingAsToken($token)->get(route('media.show', $sha));
        $response->assertOk();
        $this->assertSame(self::PNG, $response->streamedContent());
        $this->assertSame('image/png', $response->headers->get('Content-Type'));
        // Content-addressed bytes never change, so a second device fetches each
        // file exactly once, forever.
        $this->assertStringContainsString('immutable', (string) $response->headers->get('Cache-Control'));
    }

    public function test_bytes_that_do_not_hash_to_their_name_are_refused(): void
    {
        // The whole security model of a content-addressed store. Without this
        // check, `PUT /media/<sha of a widely shared image>` with different
        // bytes rewrites that image for every deck that references it.
        $user = $this->account();
        $lie = hash('sha256', 'something else entirely');

        $this->putBytes($this->tokenFor($user), $lie, self::PNG)->assertStatus(422);

        $this->assertSame(0, MediaFile::query()->count());
    }

    public function test_a_type_that_can_carry_script_is_refused(): void
    {
        // SVG is a document, and a media URL opened directly is not inside the
        // script-less iframe that card HTML gets.
        $svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
        $sha = hash('sha256', $svg);

        $this->putBytes($this->tokenFor($this->account()), $sha, $svg, 'image/svg+xml')
            ->assertStatus(422);
    }

    public function test_uploading_the_same_file_twice_is_free(): void
    {
        // The client's push loop offers everything it holds and lets the server
        // decide what is new, which is much simpler than per-device upload
        // state — so a repeat must be cheap and must not duplicate the row.
        $user = $this->account();
        $token = $this->tokenFor($user);
        $sha = hash('sha256', self::PNG);

        foreach ([1, 2] as $ignored) {
            $this->putBytes($token, $sha, self::PNG)->assertStatus(201);
        }

        $this->assertSame(1, MediaFile::query()->where('user_id', $user->id)->count());
    }

    public function test_the_server_says_which_files_it_already_has(): void
    {
        $user = $this->account();
        $token = $this->tokenFor($user);
        $mine = hash('sha256', self::PNG);
        $theirs = hash('sha256', 'not uploaded');

        $this->putBytes($token, $mine, self::PNG)->assertStatus(201);

        $this->actingAsToken($token)
            ->postJson(route('media.held'), ['sha256' => [$mine, $theirs]])
            ->assertOk()
            ->assertJsonPath('data.held', [$mine]);
    }

    public function test_one_account_cannot_read_another_account_s_files(): void
    {
        $owner = $this->account();
        $sha = hash('sha256', self::PNG);

        $this->putBytes($this->tokenFor($owner), $sha, self::PNG)->assertStatus(201);

        $this->actingAsToken($this->tokenFor($this->account()))
            ->getJson(route('media.show', $sha))
            ->assertStatus(404);
    }

    // ── a published version's bytes ───────────────────────────────────────

    public function test_a_published_version_carries_a_manifest_and_serves_it(): void
    {
        [$listing, $sha] = $this->publishedDeckWithImage();

        $version = $listing->versions()->latest('version')->firstOrFail();
        $payload = json_decode($version->payload, true);

        $this->assertSame(
            [['sha256' => $sha, 'mime' => 'image/png', 'size' => strlen(self::PNG)]],
            $payload['media'],
            'the manifest names exactly the image the cards reference',
        );

        // And a stranger — no account at all — can fetch it, because a listing
        // is shared with people who have not signed up yet.
        $response = $this->anonymous()->get(
            route('marketplace.version.media', [$listing, $version->version, $sha]),
        );
        $response->assertOk();
        $this->assertSame(self::PNG, $response->streamedContent());
    }

    public function test_a_hash_outside_the_manifest_is_not_served(): void
    {
        // The publisher owns this file; the published deck does not reference
        // it. Serving it would make publishing one deck a read of the whole
        // library.
        [$listing, $ignored] = $this->publishedDeckWithImage();
        $publisher = User::query()->find($listing->user_id);

        $other = 'private bytes';
        $otherSha = hash('sha256', $other);
        app(MediaStore::class)->put($publisher, $otherSha, $other, 'image/png');

        $version = $listing->versions()->latest('version')->firstOrFail();

        $this->anonymous()
            ->getJson(route('marketplace.version.media', [$listing, $version->version, $otherSha]))
            ->assertStatus(404);
    }

    public function test_a_taken_down_listing_stops_serving_its_images(): void
    {
        // Or the takedown is cosmetic: the cards go and the plates stay up.
        [$listing, $sha] = $this->publishedDeckWithImage();
        $version = $listing->versions()->latest('version')->firstOrFail();

        $listing->forceFill(['status' => 'removed'])->save();

        $this->anonymous()
            ->getJson(route('marketplace.version.media', [$listing, $version->version, $sha]))
            ->assertStatus(404);
    }

    public function test_a_reference_the_publisher_no_longer_holds_is_left_out(): void
    {
        // Rather than failing the publish. A deck should not become
        // unpublishable because one image went missing two years ago.
        $publisher = $this->account();
        $deck = $this->deckWithNotes($publisher);

        Note::query()->where('deck_id', $deck->id)->first()
            ?->forceFill(['fields' => ['Front' => '<img src="media/'.str_repeat('a', 64).'">', 'Back' => 'x']])
            ->save();

        $listing = $this->publishedListing($publisher, $deck);
        $payload = json_decode($listing->versions()->latest('version')->firstOrFail()->payload, true);

        $this->assertSame([], $payload['media']);
    }

    /**
     * A published deck whose first note shows an uploaded image.
     *
     * @return array{0: Listing, 1: string}
     */
    private function publishedDeckWithImage(): array
    {
        $publisher = $this->account();
        $sha = hash('sha256', self::PNG);
        app(MediaStore::class)->put($publisher, $sha, self::PNG, 'image/png');

        $deck = $this->deckWithNotes($publisher);
        Note::query()->where('deck_id', $deck->id)->first()
            ?->forceFill(['fields' => ['Front' => '<img src="media/'.$sha.'">', 'Back' => 'Aorta']])
            ->save();

        return [$this->publishedListing($publisher, $deck), $sha];
    }
}
