<?php

namespace App\Enums;

use App\Models\CardState;
use App\Models\Deck;
use App\Models\MediaFile;
use App\Models\Note;
use App\Models\NoteType;
use App\Models\Review;
use Illuminate\Database\Eloquent\Model;

/**
 * Everything a device syncs, and the shape of each.
 *
 * One enum rather than six controllers because the resources differ only in
 * their columns — the cursor, the ordering, the last-write-wins rule and the
 * envelope are identical for all of them. Adding a syncable table should be a
 * case here and nothing else.
 */
enum SyncResource: string
{
    case Decks = 'decks';
    case NoteTypes = 'note_types';
    case Notes = 'notes';
    case CardStates = 'card_states';
    case Reviews = 'reviews';
    case Media = 'media';

    /** @return class-string<Model> */
    public function model(): string
    {
        return match ($this) {
            self::Decks => Deck::class,
            self::NoteTypes => NoteType::class,
            self::Notes => Note::class,
            self::CardStates => CardState::class,
            self::Reviews => Review::class,
            self::Media => MediaFile::class,
        };
    }

    /**
     * Columns a client may write. `revision`, `user_id` and the server
     * timestamps are absent on purpose: they are the server's to decide, and a
     * client that could set its own revision could make its rows invisible to
     * every other device.
     *
     * @return list<string>
     */
    public function writable(): array
    {
        return match ($this) {
            self::Decks => ['id', 'parent_id', 'name', 'retention_target', 'new_per_day'],
            self::NoteTypes => [
                'id', 'name', 'fields', 'templates', 'css', 'kind', 'ord_field',
                'sort_field', 'field_config', 'anki_extra', 'builtin',
            ],
            // `client_created_at` is the client's own, like `client_updated_at`:
            // the table already has Laravel's `created_at` and that one is ours.
            self::Notes => [
                'id', 'guid', 'note_type_id', 'deck_id', 'fields', 'tags', 'fma_id',
                'checksum', 'client_created_at',
            ],
            // `original_deck_id` travels with `deck_id` or neither means
            // anything: a borrowed card that arrives without its home cannot be
            // sent back when the filtered deck empties (Phase 7).
            //
            // `due_override` and `forgotten_at` are here for the reason the
            // whole table exists: they are decisions, not schedule. The FSRS
            // cache still never crosses — the client rebuilds it from the log.
            self::CardStates => [
                'id', 'note_id', 'ord', 'suspended', 'buried_until', 'flag',
                'deck_id', 'original_deck_id', 'due_override', 'forgotten_at',
            ],
            self::Reviews => ['id', 'card_id', 'client_ts', 'rating', 'duration_ms', 'imported'],
            self::Media => ['sha256', 'mime', 'size'],
        };
    }

    /**
     * Append-only resources are never updated and never soft-deleted.
     *
     * The review log is the one table where a second copy of a row is a lie
     * about how much studying happened, and where an update would rewrite
     * history. It is inserted-if-absent and otherwise left alone.
     */
    public function isAppendOnly(): bool
    {
        return $this === self::Reviews;
    }

    /**
     * The column a client addresses a row by.
     *
     * Media is the one exception: it is content-addressed, so the sha256 of the
     * bytes *is* the name, and there is no separate id for a client to invent.
     */
    public function key(): string
    {
        return $this === self::Media ? 'sha256' : 'id';
    }

    /** @return list<self> */
    public static function all(): array
    {
        return self::cases();
    }
}
