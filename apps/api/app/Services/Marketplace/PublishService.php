<?php

declare(strict_types=1);

namespace App\Services\Marketplace;

use App\Contracts\Repositories\ListingRepository;
use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Models\Deck;
use App\Models\Listing;
use App\Models\ListingInstall;
use App\Models\ListingVersion;
use App\Models\Note;
use App\Models\NoteType;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * Publishing, and the snapshot that publishing freezes.
 *
 * Every publish cuts a *new version* rather than moving a pointer (PHASES §8).
 * That is the whole reason a cloner can be told "you have v3, v4 is out": the
 * bytes they took are still on file, so the client can merge upstream's changes
 * into notes it already owns instead of downloading the deck a second time.
 */
final readonly class PublishService
{
    /**
     * A deck this size is a database, not a study deck, and the snapshot lives in
     * one column until the ponytail on `listing_versions` is paid off.
     */
    public const MAX_NOTES = 20_000;

    /** A deck tree deeper than this is a cycle somebody pushed, not a subject. */
    private const MAX_DEPTH = 32;

    public function __construct(private ListingRepository $listings) {}

    /**
     * Publish a deck, or cut the next version of one already listed.
     *
     * Authorization — ownership and the verified-email gate — is the policy's
     * job and has already run; what is decided here is which *state* the new
     * version lands in. A publisher no human has ever approved goes to
     * `in_review` and does not distribute, which is PHASES §8's "new accounts
     * unlisted until first review" in the only form that actually holds: not a
     * visibility default the publisher can flip, but a status only a moderator
     * can move.
     *
     * @param  array{deck_id: string, title: string, description?: ?string, tags?: list<string>, visibility?: string, semver?: ?string, changelog?: ?string, rights_attestation: string}  $input
     */
    public function publish(User $publisher, array $input, ?string $ip = null): Listing
    {
        $deck = Deck::query()
            ->ownedBy($publisher)
            ->whereNull('deleted_at')
            ->find($input['deck_id']);

        if ($deck === null) {
            throw new ApiException(ApiErrorCode::NotFound, 'That deck does not exist.');
        }

        $snapshot = $this->snapshot($publisher, $deck);
        $trusted = $this->listings->hasApprovedListing($publisher);

        return DB::transaction(function () use ($publisher, $deck, $input, $snapshot, $trusted, $ip): Listing {
            $listing = Listing::query()->firstOrNew([
                'user_id' => $publisher->id,
                'deck_id' => $deck->id,
            ]);

            $status = $trusted ? Listing::STATUS_PUBLISHED : Listing::STATUS_IN_REVIEW;

            $listing->fill([
                'title' => $input['title'],
                'description' => $input['description'] ?? null,
                'tags' => $this->normaliseTags($input['tags'] ?? []),
                'visibility' => $input['visibility'] ?? Listing::VISIBILITY_UNLISTED,
                'status' => $status,
                'latest_version' => ((int) $listing->latest_version) + 1,
                'published_at' => $status === Listing::STATUS_PUBLISHED
                    ? ($listing->published_at ?? Carbon::now())
                    : null,
            ]);
            $listing->save();

            $payload = json_encode($snapshot, JSON_THROW_ON_ERROR);

            ListingVersion::query()->create([
                'listing_id' => $listing->id,
                'version' => $listing->latest_version,
                'semver' => $input['semver'] ?? null,
                'changelog' => $input['changelog'] ?? null,
                'payload' => $payload,
                'checksum' => hash('sha256', $payload),
                'note_count' => count($snapshot['notes']),
                'size_bytes' => strlen($payload),
                'rights_attestation' => $input['rights_attestation'],
                'attested_ip' => $ip,
            ]);

            return $listing->refresh();
        });
    }

    /**
     * The publisher's own stop button: distribution ends, versions stay on file.
     *
     * Deliberately not a delete. Somebody's clone is theirs, the audit trail of
     * what was published is evidence, and both survive this.
     */
    public function unpublish(Listing $listing): Listing
    {
        $listing->update(['status' => Listing::STATUS_DRAFT, 'published_at' => null]);

        return $listing;
    }

    /**
     * Record that a deck in someone's collection came from this listing.
     *
     * Bookkeeping, not the clone: the clone itself is written by the client into
     * its own SQLite and reaches the server through ordinary sync, as the
     * cloner's own rows. Keeping it that way is what makes rule "a clone is a
     * copy" structural rather than a promise — there is no code path by which a
     * publisher writes into another account's collection.
     */
    public function recordInstall(User $cloner, Listing $listing, string $deckId, int $version): ListingInstall
    {
        if (! $listing->isDistributable() || $version > $listing->latest_version) {
            throw new ApiException(ApiErrorCode::NotFound, 'That deck is no longer available.');
        }

        $install = ListingInstall::query()->firstOrNew([
            'user_id' => $cloner->id,
            'deck_id' => $deckId,
        ]);

        $isNew = ! $install->exists;
        $install->fill(['listing_id' => $listing->id, 'version' => $version])->save();

        // Only a first install counts. Re-cloning after an update is the same
        // person with the same deck, and counting it again would make the
        // busiest deck the one with the most updates.
        if ($isNew) {
            $listing->increment('install_count');
        }

        return $install;
    }

    /**
     * The deck as a cloner needs it: the subtree, its note types, its notes.
     *
     * Note identity is published as `source_guid`, *never* as `guid`. A clone
     * mints its own with {@see CloneGuid}, and the name here is the guard rail:
     * a field called `guid` in this payload is one careless assignment away from
     * corrupting the cloner's collection.
     *
     * The deck and note-type ids are wiring — they say which note belongs to
     * which subdeck and which template — and are not identity. The client mints
     * its own ids for both (note types match on name plus field signature,
     * CARDS.md §4.5).
     *
     * ponytail: no media. The bytes live on a per-account disk with no public
     * read path, so a sha256 manifest here would only promise images the client
     * cannot fetch. The upgrade is a manifest plus
     * `GET /marketplace/media/{sha256}` scoped to a published version, and until
     * it exists a published deck's images arrive broken.
     *
     * @return array{decks: list<array<string, mixed>>, note_types: list<array<string, mixed>>, notes: list<array<string, mixed>>}
     */
    private function snapshot(User $publisher, Deck $root): array
    {
        $decks = $this->subtree($publisher, $root);
        $deckIds = $decks->pluck('id')->all();

        $notes = Note::query()
            ->ownedBy($publisher)
            ->whereIn('deck_id', $deckIds)
            ->whereNull('deleted_at')
            ->limit(self::MAX_NOTES + 1)
            ->get(['guid', 'note_type_id', 'deck_id', 'fields', 'tags']);

        if ($notes->count() > self::MAX_NOTES) {
            throw new ApiException(
                ApiErrorCode::PayloadTooLarge,
                'A published deck is limited to '.self::MAX_NOTES.' notes.',
            );
        }

        $noteTypes = NoteType::query()
            ->ownedBy($publisher)
            ->whereIn('id', $notes->pluck('note_type_id')->unique()->all())
            ->whereNull('deleted_at')
            ->get(['id', 'name', 'fields', 'templates', 'css', 'kind', 'ord_field', 'sort_field', 'field_config', 'anki_extra']);

        return [
            'decks' => $decks->map(fn (Deck $deck): array => [
                'id' => $deck->id,
                // The root is published as a root: its parent is the publisher's
                // collection, which is none of the cloner's business.
                'parent_id' => $deck->id === $root->id ? null : $deck->parent_id,
                'name' => $deck->name,
                'retention_target' => $deck->retention_target,
                'new_per_day' => $deck->new_per_day,
            ])->values()->all(),
            'note_types' => $noteTypes->map(fn (NoteType $type): array => $type->only([
                'id', 'name', 'fields', 'templates', 'css', 'kind', 'ord_field', 'sort_field', 'field_config', 'anki_extra',
            ]))->values()->all(),
            'notes' => $notes->map(fn (Note $note): array => [
                'source_guid' => $note->guid,
                'note_type_id' => $note->note_type_id,
                'deck_id' => $note->deck_id,
                'fields' => $note->fields,
                'tags' => $note->tags,
            ])->values()->all(),
        ];
    }

    /**
     * Breadth-first, one query per level.
     *
     * A recursive CTE would be one query, but this runs on a tree that is four
     * deep in practice and the loop is the same on MySQL and on the SQLite the
     * tests use. The depth cap is the cycle guard: `parent_id` is client-written,
     * so a loop in it is a malformed push, not an impossibility.
     *
     * @return Collection<int, Deck>
     */
    private function subtree(User $publisher, Deck $root): Collection
    {
        $collected = collect([$root]);
        $frontier = [$root->id];

        for ($depth = 0; $depth < self::MAX_DEPTH && $frontier !== []; $depth++) {
            $children = Deck::query()
                ->ownedBy($publisher)
                ->whereIn('parent_id', $frontier)
                ->whereNotIn('id', $collected->pluck('id')->all())
                ->whereNull('deleted_at')
                ->get();

            $collected = $collected->concat($children);
            $frontier = $children->pluck('id')->all();
        }

        return $collected;
    }

    /**
     * @param  list<string>  $tags
     */
    private function normaliseTags(array $tags): string
    {
        return collect($tags)
            ->map(fn (string $tag): string => mb_strtolower(trim($tag)))
            ->filter(fn (string $tag): bool => $tag !== '')
            // A space is the separator, so a tag may not contain one.
            ->map(fn (string $tag): string => str_replace(' ', '-', $tag))
            ->unique()
            ->take(10)
            ->implode(' ');
    }
}
