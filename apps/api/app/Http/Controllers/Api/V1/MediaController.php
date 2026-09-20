<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Models\Listing;
use App\Models\ListingVersion;
use App\Models\User;
use App\Services\Media\MediaStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Moving the bytes.
 *
 * Three routes, and the third is the one the marketplace has been missing:
 *
 * - `PUT /media/{sha256}` and `GET /media/{sha256}` carry an account's own
 *   files between its own devices, which is what makes a card authored on a
 *   laptop show its diagram on a phone.
 * - `GET /marketplace/listings/{listing}/versions/{version}/media/{sha256}`
 *   serves a *published version's* bytes to anyone who may read that version.
 *   Scoped to the version's manifest on purpose: the publisher's account may
 *   hold ten thousand images and exactly the ones in the deck they published
 *   are public. Anything looser turns a publish into a read of a private disk.
 */
class MediaController extends Controller
{
    use RespondsWithApi;

    public function __construct(private readonly MediaStore $media) {}

    /**
     * Upload one file, named by the digest of its own bytes.
     *
     * The body is the raw bytes rather than a multipart form: there is exactly
     * one file, its name is in the URL, and multipart would add a parser and a
     * temporary file for no gain.
     */
    public function store(Request $request, string $sha256): JsonResponse
    {
        $file = $this->media->put(
            $request->user(),
            $sha256,
            $request->getContent(),
            // The declared type is checked against an allow-list in the store.
            // A missing header is a client bug, not a reason to guess.
            $request->header('Content-Type') ?? '',
        );

        return $this->created([
            'sha256' => $file->sha256,
            'mime' => $file->mime,
            'size' => (int) $file->size,
        ]);
    }

    /** Which of these the server already has, so the client uploads only the rest. */
    public function held(Request $request): JsonResponse
    {
        $data = $request->validate([
            'sha256' => ['required', 'array', 'max:500'],
            'sha256.*' => ['string', 'size:64'],
        ]);

        return $this->ok(['held' => $this->media->held($request->user(), $data['sha256'])]);
    }

    public function show(Request $request, string $sha256): StreamedResponse
    {
        $file = $this->media->find($request->user(), $sha256);

        if ($file === null) {
            throw new ApiException(ApiErrorCode::NotFound, 'No such file on this account.');
        }

        return $this->stream($this->media->read($file), $file->mime, $sha256);
    }

    /**
     * A published version's media, to anyone who may read that version.
     *
     * Two gates, both necessary. The listing must be distributable — a taken
     * down deck stops serving its images at the same moment it stops serving
     * its cards, or the takedown is cosmetic. And the hash must appear in
     * *this version's* manifest, which is what stops the route becoming a
     * lookup into the publisher's whole library.
     */
    public function version(Request $request, Listing $listing, int $version, string $sha256): StreamedResponse
    {
        if (! $listing->isDistributable()) {
            throw new ApiException(ApiErrorCode::NotFound, 'That deck is no longer available.');
        }

        $row = ListingVersion::query()
            ->where('listing_id', $listing->id)
            ->where('version', $version)
            ->first();

        if ($row === null) {
            throw new ApiException(ApiErrorCode::NotFound, 'No such version.');
        }

        $manifest = json_decode($row->payload, true, flags: JSON_THROW_ON_ERROR)['media'] ?? [];
        $sha256 = strtolower($sha256);

        $listed = collect(is_array($manifest) ? $manifest : [])
            ->contains(fn ($entry): bool => strtolower((string) ($entry['sha256'] ?? '')) === $sha256);

        if (! $listed) {
            throw new ApiException(ApiErrorCode::NotFound, 'That file is not part of this version.');
        }

        // Read from the *publisher's* store. The manifest already decided this
        // hash is public for this version; the owner lookup is only how the
        // bytes are found.
        $publisher = User::query()->find($listing->user_id);
        $file = $publisher ? $this->media->find($publisher, $sha256) : null;

        if ($file === null) {
            throw new ApiException(ApiErrorCode::NotFound, 'The publisher no longer has that file.');
        }

        return $this->stream($this->media->read($file), $file->mime, $sha256);
    }

    /**
     * Content-addressed bytes never change, so they are cached hard and
     * immutably. That is the one real dividend of naming a file by its hash:
     * a second device fetches each image exactly once, forever.
     */
    private function stream(string $bytes, string $mime, string $sha256): StreamedResponse
    {
        return response()->stream(
            function () use ($bytes): void {
                echo $bytes;
            },
            Response::HTTP_OK,
            [
                'Content-Type' => $mime,
                'Content-Length' => (string) strlen($bytes),
                'Cache-Control' => 'private, max-age=31536000, immutable',
                'ETag' => '"'.$sha256.'"',
                // Never inline. These bytes are user-supplied and a browser
                // deciding to render them as a document is the one thing the
                // mime allow-list is guarding against.
                'Content-Disposition' => 'attachment',
                'X-Content-Type-Options' => 'nosniff',
            ],
        );
    }
}
