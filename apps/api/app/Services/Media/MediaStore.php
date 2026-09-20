<?php

declare(strict_types=1);

namespace App\Services\Media;

use App\Contracts\Repositories\UserRepository;
use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Models\MediaFile;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * The bytes behind a sha256, for one account.
 *
 * Media has been content-addressed since Phase 1 and the metadata has synced
 * since Phase 5 — what never existed was a way to move the *bytes*. So a deck
 * of anatomy plates has published, cloned and co-edited perfectly, and arrived
 * blank, for four phases. This is that gap.
 *
 * **The hash is checked, not trusted.** The client names the file by the digest
 * of its contents, so the server recomputes it and refuses a mismatch. Without
 * that check, `PUT /media/<sha of an image everyone shares>` with different
 * bytes would poison one hash for every deck that references it — content
 * addressing's one real failure mode, and it costs a `hash()` call to close.
 *
 * Storage is per account (`media/{user}/{sha}`), matching what the `.apkg`
 * importer already writes. Two accounts holding the same image store it twice,
 * which is the deliberate trade: cross-account deduplication would mean one
 * person's delete could take another's bytes, and reference counting across
 * accounts is a much bigger thing than a duplicated PNG.
 */
final readonly class MediaStore
{
    /** Anything larger is not a flashcard illustration. */
    public const MAX_BYTES = 20 * 1024 * 1024;

    /**
     * What may be stored.
     *
     * An allow-list, because this is one of the few endpoints that stores bytes
     * somebody else may later fetch. **SVG is absent on purpose**: it is a
     * document that can carry script, and while `CardFrame` renders card HTML
     * in a script-less iframe, a media URL opened directly is not inside one.
     */
    public const MIMES = [
        'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
        'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/opus', 'audio/flac',
    ];

    public function __construct(private UserRepository $users) {}

    /**
     * Store bytes the client has named by their digest.
     *
     * Idempotent, and cheaply so: re-uploading a file this account already has
     * returns the existing row untouched. The client's push loop leans on that
     * — it offers everything it holds and lets the server decide what is new,
     * which is far simpler than tracking per-device upload state.
     */
    public function put(User $user, string $sha256, string $bytes, string $mime): MediaFile
    {
        $sha256 = strtolower($sha256);

        if (! preg_match('/^[a-f0-9]{64}$/', $sha256)) {
            throw new ApiException(ApiErrorCode::ValidationFailed, 'That is not a sha256.');
        }

        if ($bytes === '') {
            throw new ApiException(ApiErrorCode::ValidationFailed, 'Nothing was uploaded.');
        }

        if (strlen($bytes) > self::MAX_BYTES) {
            throw new ApiException(ApiErrorCode::PayloadTooLarge, 'That file is larger than 20 MB.');
        }

        // The whole security model of a content-addressed store. A client that
        // could name bytes whatever it liked could overwrite a hash that other
        // decks reference.
        if (hash('sha256', $bytes) !== $sha256) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'Those bytes do not hash to that name.',
            );
        }

        if (! in_array($mime, self::MIMES, true)) {
            throw new ApiException(ApiErrorCode::ValidationFailed, 'That file type cannot be stored.');
        }

        $existing = MediaFile::query()
            ->where('user_id', $user->id)
            ->where('sha256', $sha256)
            ->first();

        if ($existing !== null && $existing->completed_at !== null) {
            return $existing;
        }

        $path = "media/{$user->id}/{$sha256}";
        if (! Storage::exists($path)) {
            Storage::put($path, $bytes);
        }

        return MediaFile::query()->updateOrCreate(
            ['user_id' => $user->id, 'sha256' => $sha256],
            [
                'id' => $existing?->id ?? (string) Str::uuid(),
                'mime' => $mime,
                'size' => strlen($bytes),
                'path' => $path,
                'completed_at' => Carbon::now(),
                // Allocated so the row travels on the next pull like any other
                // synced resource — the metadata and the bytes stay in step.
                'revision' => $this->users->allocateRevisions($user),
            ],
        );
    }

    /** The row, if this account has the bytes and the upload finished. */
    public function find(User $user, string $sha256): ?MediaFile
    {
        return MediaFile::query()
            ->where('user_id', $user->id)
            ->where('sha256', strtolower($sha256))
            ->whereNotNull('completed_at')
            ->first();
    }

    /**
     * Which of these this account already has.
     *
     * The client asks before it uploads, so a device that reinstalls does not
     * push a library it has already pushed. One indexed query per batch.
     *
     * @param  list<string>  $shas
     * @return list<string>
     */
    public function held(User $user, array $shas): array
    {
        if ($shas === []) {
            return [];
        }

        return MediaFile::query()
            ->where('user_id', $user->id)
            ->whereIn('sha256', array_map('strtolower', $shas))
            ->whereNotNull('completed_at')
            ->pluck('sha256')
            ->all();
    }

    /** @return string the raw bytes */
    public function read(MediaFile $file): string
    {
        $bytes = Storage::get($file->path);

        if ($bytes === null) {
            // The row says the bytes are here and they are not. That is a
            // corrupted store, not a missing file, and it should read as one.
            throw new ApiException(ApiErrorCode::NotFound, 'Those bytes are no longer on the server.');
        }

        return $bytes;
    }
}
