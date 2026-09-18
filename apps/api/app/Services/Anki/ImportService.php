<?php

declare(strict_types=1);

namespace App\Services\Anki;

use App\Contracts\Repositories\UserRepository;
use App\Models\Deck;
use App\Models\MediaFile;
use App\Models\Note;
use App\Models\Review;
use App\Models\User;
use App\Services\Sync\SyncService;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Ramsey\Uuid\Uuid;

/**
 * Importing an `.apkg` into an account — the server half of what
 * `apps/web/src/lib/anki/import.ts` does on a device.
 *
 * The order is forced by what depends on what: media before notes, because a
 * note's fields are rewritten onto content hashes; note types before notes,
 * because a note without its type cannot be rendered; decks before cards,
 * because a card has to land somewhere. Notes come through in pages so a
 * 20,000-card deck reports progress instead of holding one transaction open
 * for a minute.
 *
 * **Nothing here writes a row a client push could not have written.** Rows go
 * through `SyncService::push()`, which is what makes an import indistinguishable
 * from a device's own writes: same last-write-wins rule, same revision
 * allocation, same tombstones — and therefore no second write path to drift.
 * Reviews and media are the two exceptions, and each says why below.
 *
 * What it deliberately does not do is generate cards. `cards` is a derived
 * cache (README rule 1) and is not a syncable table; each device regenerates
 * its own from the note and its templates. Only what Anki *recorded* — which
 * ordinals had cards, where they lived, what was answered — crosses over.
 */
final class ImportService
{
    private const PAGE = 250;

    public function __construct(
        private readonly SyncService $sync,
        private readonly UserRepository $users,
    ) {}

    /**
     * @param  (callable(string, int, int): void)|null  $onProgress  stage, done, total
     * @return array<string, int>
     */
    public function import(User $user, string $archivePath, ?callable $onProgress = null): array
    {
        $progress = $onProgress ?? static fn (string $stage, int $done, int $total): null => null;
        $apkg = Apkg::open($archivePath);

        try {
            $collection = Collection::open($apkg->collectionPath());

            $progress('media', 0, count($apkg->mediaNames()));
            [$hashes, $sizes] = $this->importMedia($user, $apkg, $progress);

            $deckIds = $this->importDecks($user, $collection->decks());
            $noteTypes = $this->importNoteTypes($user, $collection->noteTypes(), $deckIds);

            $report = [
                'note_types' => count($noteTypes),
                'decks' => count($deckIds),
                'media' => count($hashes),
                'notes_added' => 0,
                'notes_updated' => 0,
                'reviews' => 0,
                'latex_notes' => $collection->countLatex(),
                'occlusion_skipped' => 0,
            ];

            $total = $collection->countNotes();
            for ($offset = 0; $offset < $total; $offset += self::PAGE) {
                $page = $collection->notes(self::PAGE, $offset);
                if ($page === []) {
                    break;
                }

                $this->importPage($user, $collection, $page, $noteTypes, $deckIds, $hashes, $sizes, $report);
                $progress('notes', min($offset + self::PAGE, $total), $total);
            }

            $progress('done', $total, $total);

            return $report;
        } finally {
            $apkg->close();
        }
    }

    /**
     * Media, content-addressed by the sha256 of the bytes.
     *
     * Image dimensions are measured here rather than later because the bytes
     * are in hand exactly once — `getimagesizefromstring` is what the browser
     * needed the `createImageBitmap` dance for, and occlusion coordinates are
     * unusable without it.
     *
     * Rows are written directly rather than through `SyncService::push()`:
     * `media` has no `client_updated_at` column, which the push path sets on
     * every non-append-only resource.
     *
     * @param  callable(string, int, int): void  $progress
     * @return array{0: array<string, string>, 1: array<string, array{0: int, 1: int}>}
     */
    private function importMedia(User $user, Apkg $apkg, callable $progress): array
    {
        $hashes = [];
        $sizes = [];
        $names = $apkg->mediaNames();
        $done = 0;

        foreach ($names as $name) {
            $bytes = $apkg->media($name);
            if ($bytes === null) {
                continue;
            }

            $sha = hash('sha256', $bytes);
            $hashes[$name] = $sha;

            $measured = @getimagesizefromstring($bytes);
            if ($measured !== false) {
                $sizes[$sha] = [(int) $measured[0], (int) $measured[1]];
            }

            $path = "media/{$user->id}/{$sha}";
            if (! Storage::exists($path)) {
                Storage::put($path, $bytes);
            }

            MediaFile::query()->updateOrCreate(
                ['user_id' => $user->id, 'sha256' => $sha],
                [
                    'id' => (string) Str::uuid(),
                    'mime' => $this->mimeOf($name),
                    'size' => strlen($bytes),
                    'path' => $path,
                    'completed_at' => Carbon::now(),
                    'revision' => $this->users->allocateRevisions($user),
                ],
            );

            $progress('media', ++$done, count($names));
        }

        return [$hashes, $sizes];
    }

    /**
     * Anki deck id → ours, creating the tree as it goes.
     *
     * Anki has no deck tree — it has flat names with `::` separators — so the
     * path is split and each component found or created, which is
     * `repo.deckByPath` on the device.
     *
     * @param  array<string, string>  $paths
     * @return array<string, string>
     */
    private function importDecks(User $user, array $paths): array
    {
        $created = [];
        $byPath = [];
        $out = [];

        foreach ($paths as $did => $path) {
            $parent = null;
            $walked = '';

            foreach (array_filter(array_map(trim(...), explode('::', $path)), fn (string $p): bool => $p !== '') as $name) {
                $walked = $walked === '' ? $name : $walked.'::'.$name;

                if (isset($byPath[$walked])) {
                    $parent = $byPath[$walked];

                    continue;
                }

                $existing = Deck::query()->ownedBy($user)
                    ->where('name', $name)
                    ->when($parent === null,
                        fn ($q) => $q->whereNull('parent_id'),
                        fn ($q) => $q->where('parent_id', $parent),
                    )
                    ->whereNull('deleted_at')
                    ->first();

                if ($existing !== null) {
                    $parent = $byPath[$walked] = (string) $existing->id;

                    continue;
                }

                $id = (string) Str::uuid();
                $created[] = [
                    'id' => $id,
                    'parent_id' => $parent,
                    'name' => $name,
                    'retention_target' => 0.9,
                    'new_per_day' => 20,
                    'client_updated_at' => Carbon::now()->getTimestampMs(),
                ];
                // Pushed immediately: the next component names this one as its
                // parent, and a parent that is not in the table yet would make
                // the branch unreachable from any root.
                $this->sync->push($user, ['decks' => [$created[array_key_last($created)]]]);
                $parent = $byPath[$walked] = $id;
            }

            if ($parent !== null) {
                $out[(string) $did] = $parent;
            }
        }

        return $out;
    }

    /**
     * @param  array<string, array<string, mixed>>  $types
     * @param  array<string, string>  $deckIds
     * @return array<string, array<string, mixed>>
     */
    private function importNoteTypes(User $user, array $types, array $deckIds): array
    {
        $rows = [];
        $out = [];
        $now = Carbon::now()->getTimestampMs();

        foreach ($types as $mid => $type) {
            // Namespaced so an Anki id can never collide with `basic` or a type
            // the user made, and stable so a re-import updates rather than
            // duplicates.
            $id = 'anki:'.$mid;
            $type['id'] = $id;
            $type['templates'] = array_map(function (array $template) use ($deckIds): array {
                // The override arrives as an Anki deck id and has to become ours.
                $template['deckOverride'] = $template['deckOverride'] === null
                    ? null
                    : ($deckIds[$template['deckOverride']] ?? null);

                return $template;
            }, $type['templates']);

            $out[(string) $mid] = $type;
            $rows[] = [
                'id' => $id,
                'name' => $type['name'],
                'fields' => self::json($type['fields']),
                'templates' => self::json($type['templates']),
                'css' => $type['css'],
                'kind' => $type['kind'],
                'ord_field' => $type['ordField'],
                'sort_field' => $type['sortField'],
                'field_config' => self::json($type['fieldConfig']),
                'anki_extra' => self::json($type['ankiExtra']),
                'builtin' => false,
                'client_updated_at' => $now,
            ];
        }

        if ($rows !== []) {
            $this->sync->push($user, ['note_types' => $rows]);
        }

        return $out;
    }

    /**
     * One page of notes, their cards' decks and their history.
     *
     * Everything matches on **guid** (CARDS.md §4.5): import the same deck
     * twice and the second run updates in place; import v2 of a shared deck and
     * the scheduling every device derived from the review log survives, because
     * the log is never rewritten.
     *
     * @param  list<array<string, mixed>>  $page
     * @param  array<string, array<string, mixed>>  $noteTypes
     * @param  array<string, string>  $deckIds
     * @param  array<string, string>  $hashes
     * @param  array<string, array{0: int, 1: int}>  $sizes
     * @param  array<string, int>  $report
     */
    private function importPage(
        User $user,
        Collection $collection,
        array $page,
        array $noteTypes,
        array $deckIds,
        array $hashes,
        array $sizes,
        array &$report,
    ): void {
        $noteIds = array_map(fn (array $n): int => $n['id'], $page);
        $cards = $collection->cards($noteIds);
        $log = $collection->reviews(array_map(fn (array $c): int => $c['id'], $cards));

        $known = Note::query()->ownedBy($user)
            ->whereIn('guid', array_map(fn (array $n): string => $n['guid'], $page))
            ->pluck('id', 'guid')
            ->all();

        $fallback = null;
        $notes = [];
        $states = [];
        $reviews = [];

        foreach ($page as $note) {
            $type = $noteTypes[$note['mid']] ?? null;
            // A note whose type did not come with the deck cannot be rendered,
            // and inventing one would put its content in boxes nobody chose.
            if ($type === null) {
                continue;
            }

            $id = (string) ($known[$note['guid']] ?? Str::uuid());
            isset($known[$note['guid']]) ? $report['notes_updated']++ : $report['notes_added']++;

            $fields = [];
            foreach ($type['fields'] as $i => $name) {
                $fields[$name] = Mapping::rewriteMedia(
                    $note['fields'][$i] ?? '',
                    fn (string $file): ?string => isset($hashes[$file]) ? 'media/'.$hashes[$file] : null,
                );
            }
            if ($type['kind'] === 'occlusion' && ! $this->convertOcclusion($fields, $type, $hashes, $sizes)) {
                $report['occlusion_skipped']++;
            }

            $mine = array_values(array_filter($cards, fn (array $c): bool => $c['nid'] === $note['id']));
            // `odid` is the card's home deck while it sits in a filtered deck;
            // the filtered deck itself is a view, and Phase 7 builds our own.
            $deckOf = fn (array $c): ?string => $deckIds[(string) ($c['odid'] ?: $c['did'])] ?? null;
            $home = ($mine === [] ? null : $deckOf($mine[0]))
                ?? $deckIds['1']
                ?? ($fallback ??= $this->importDecks($user, ['fallback' => 'Imported'])['fallback']);

            $notes[] = [
                'id' => $id,
                'guid' => $note['guid'],
                'note_type_id' => $type['id'],
                'deck_id' => $home,
                'fields' => self::json($fields),
                'tags' => implode(' ', $note['tags']),
                'fma_id' => null,
                'checksum' => $this->fieldChecksum($fields[$type['fields'][0] ?? ''] ?? ''),
                'client_updated_at' => $note['mod'] * 1000,
            ];

            foreach ($mine as $card) {
                $cardId = $id.':'.$card['ord'];
                $deck = $deckOf($card);

                // Only an actual override is worth a row. A card that follows
                // its note is the default, and 20,000 rows saying so is 20,000
                // rows every device then has to pull.
                if ($deck !== null && $deck !== $home) {
                    $states[] = [
                        'id' => $cardId,
                        'note_id' => $id,
                        'ord' => $card['ord'],
                        'suspended' => false,
                        'buried_until' => null,
                        'flag' => 0,
                        'deck_id' => $deck,
                        'client_updated_at' => $note['mod'] * 1000,
                    ];
                }

                foreach ($log as $entry) {
                    if ($entry['cid'] !== $card['id']) {
                        continue;
                    }
                    $reviews[] = [
                        // Derived from the card and the instant, so importing
                        // the same deck twice does not double the log: an answer
                        // is identified by which card and when, never by a fresh
                        // id (repo.ts `importNotes` deduplicates on the same pair).
                        'id' => Uuid::uuid5(Uuid::NAMESPACE_URL, "recall:review:{$cardId}@{$entry['id']}")->toString(),
                        'card_id' => $cardId,
                        // Anki's revlog id is the review's epoch-millisecond time.
                        'client_ts' => $entry['id'],
                        'rating' => min(4, max(1, $entry['ease'])),
                        'duration_ms' => $entry['time'],
                        'imported' => true,
                    ];
                }
            }
        }

        if ($notes !== []) {
            $this->sync->push($user, array_filter([
                'notes' => $notes,
                'card_states' => $states,
            ]));
        }

        $report['reviews'] += $this->insertReviews($user, $reviews);
    }

    /**
     * Imported history, inserted if absent and never updated.
     *
     * It does not go through `SyncService::push()` for one reason: that path
     * clamps `client_ts` to the product's own epoch, which is right for a phone
     * with a wrong clock and wrong for an `.apkg` — a real collection carries
     * answers from years before this product existed, and clamping them forward
     * would compress a decade of history onto one afternoon. Everything else
     * here is the append-only rule as `push()` applies it.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function insertReviews(User $user, array $rows): int
    {
        if ($rows === []) {
            return 0;
        }

        $keyed = array_column($rows, null, 'id');
        $present = Review::query()->ownedBy($user)->whereIn('id', array_keys($keyed))->pluck('id')->all();
        $fresh = array_diff_key($keyed, array_flip($present));
        if ($fresh === []) {
            return 0;
        }

        $now = Carbon::now();
        $revision = $this->users->allocateRevisions($user, count($fresh));
        $insert = [];

        foreach ($fresh as $row) {
            $insert[] = [
                ...$row,
                'user_id' => $user->id,
                'server_received_at' => $now->getTimestampMs(),
                'revision' => $revision++,
                'created_at' => $now,
            ];
        }

        Review::query()->insert($insert);

        return count($insert);
    }

    /**
     * Anki's image-occlusion shapes are pixels against the image's natural
     * size; ours are 0–1 so a mask survives the image being re-encoded.
     *
     * False when the image could not be measured. The field is then left
     * exactly as Anki wrote it and the card renders as the bare plate: visibly
     * missing its masks, rather than wearing masks in the wrong places.
     *
     * @param  array<string, string>  $fields
     * @param  array<string, mixed>  $type
     * @param  array<string, string>  $hashes
     * @param  array<string, array{0: int, 1: int}>  $sizes
     */
    private function convertOcclusion(array &$fields, array $type, array $hashes, array $sizes): bool
    {
        $field = $type['ordField'] ?? 'Occlusion';
        $occlusion = Mapping::parseAnkiOcclusion($fields[$field] ?? '');
        if ($occlusion['shapes'] === []) {
            return true;
        }

        $image = $fields['Image'] ?? '';
        $sha = preg_match('/media\/([0-9a-f]{64})/', $image, $m) === 1 ? $m[1] : null;
        if ($sha === null) {
            $name = Mapping::mediaNames($image)[0] ?? null;
            $sha = $name === null ? null : ($hashes[$name] ?? null);
        }

        $size = $sha === null ? null : ($sizes[$sha] ?? null);
        $json = $size === null ? null : Mapping::normaliseOcclusion($occlusion, $size[0], $size[1]);
        if ($json === null) {
            return false;
        }

        $fields[$field] = $json;

        return true;
    }

    /**
     * The duplicate-warning checksum, FNV-1a over the stripped first field.
     *
     * Not Anki's `csum` — this is `identity.ts` in PHP, and it has to agree
     * with it digit for digit, because the device that pulls this note compares
     * it against checksums it computed itself.
     */
    private function fieldChecksum(string $firstField): int
    {
        $entities = ['&amp;' => '&', '&lt;' => '<', '&gt;' => '>', '&quot;' => '"', '&#39;' => "'", '&nbsp;' => ' '];
        $text = preg_replace('/<(br|\/p|\/div|\/li)[^>]*>/i', ' ', $firstField) ?? $firstField;
        $text = strtr(preg_replace('/<[^>]*>/', '', $text) ?? $text, $entities);
        $text = trim((string) preg_replace('/\s+/', ' ', $text));

        $hash = 0x811C9DC5;
        // UTF-16 code units, not code points: JavaScript's `charCodeAt` hashes
        // a surrogate pair as two units, and a checksum that disagrees on one
        // emoji is a duplicate warning that fires on a device and not on the
        // server.
        foreach (unpack('v*', mb_convert_encoding($text, 'UTF-16LE', 'UTF-8')) ?: [] as $unit) {
            $hash ^= $unit;
            // 32-bit wraparound, which `Math.imul` gives JavaScript for free.
            $hash = ($hash * 0x01000193) & 0xFFFFFFFF;
        }

        // Signed, so it stores as a plain INTEGER on both sides.
        return $hash >= 0x80000000 ? $hash - 0x100000000 : $hash;
    }

    /**
     * A value bound for a `json` column, wrapped so exactly one encoder runs.
     *
     * `SyncService::writableOnly()` encodes arrays on the way past and the
     * model's `array` cast encodes again, which stores a JSON *string* of JSON
     * and hands the next device a string where it expects an object. A
     * Collection is not an array, so it reaches the cast untouched — and still
     * encodes to the same shape once that double encode is fixed at the source.
     *
     * @param  array<array-key, mixed>  $value
     * @return \Illuminate\Support\Collection<array-key, mixed>
     */
    private static function json(array $value): \Illuminate\Support\Collection
    {
        return collect($value);
    }

    /**
     * Anki addresses media by filename, so the only clue to a file's type is
     * its extension — there is no `Content-Type` inside a zip.
     */
    private function mimeOf(string $name): string
    {
        $types = [
            'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif',
            'webp' => 'image/webp', 'avif' => 'image/avif', 'svg' => 'image/svg+xml', 'bmp' => 'image/bmp',
            'mp3' => 'audio/mpeg', 'ogg' => 'audio/ogg', 'oga' => 'audio/ogg', 'wav' => 'audio/wav',
            'm4a' => 'audio/mp4', 'opus' => 'audio/opus', 'flac' => 'audio/flac',
            'mp4' => 'video/mp4', 'webm' => 'video/webm', 'mov' => 'video/quicktime',
        ];

        return $types[strtolower(pathinfo($name, PATHINFO_EXTENSION))] ?? 'application/octet-stream';
    }
}
