<?php

declare(strict_types=1);

namespace App\Services\Anki;

use RuntimeException;
use ZipArchive;

/**
 * Opening the `.apkg` container itself — the PHP twin of
 * `apps/web/src/lib/anki/apkg.ts`.
 *
 * Three formats are in circulation and a deck downloaded today may be any of
 * them:
 *
 * | entry | schema | since |
 * |---|---|---|
 * | `collection.anki2` | 11 | Anki 2.0 |
 * | `collection.anki21` | 11 or 18 | Anki 2.1 |
 * | `collection.anki21b` | 18, zstd-compressed | Anki 2.1.50 |
 *
 * The newest is preferred where several are present — 2.1 exports ship a
 * deliberately empty `collection.anki2` beside the real one so that Anki 2.0
 * shows a readable error instead of a crash.
 *
 * The collection is written to a temp file rather than read into memory,
 * because `pdo_sqlite` opens paths, not strings.
 */
final class Apkg
{
    private const COLLECTIONS = ['collection.anki21b', 'collection.anki21', 'collection.anki2'];

    /**
     * @param  array<string, string>  $media  filename → the zip entry holding its bytes
     */
    private function __construct(
        private readonly ZipArchive $zip,
        private readonly string $collectionPath,
        private readonly array $media,
        private readonly bool $zstd,
    ) {}

    public static function open(string $archivePath): self
    {
        $zip = new ZipArchive;
        if ($zip->open($archivePath, ZipArchive::RDONLY) !== true) {
            throw new RuntimeException('That file is not a readable zip archive');
        }

        $name = null;
        foreach (self::COLLECTIONS as $candidate) {
            if ($zip->locateName($candidate) !== false) {
                $name = $candidate;
                break;
            }
        }
        if ($name === null) {
            throw new RuntimeException('That does not look like an Anki deck — no collection inside');
        }

        $zstd = $zip->locateName('collection.anki21b') !== false;
        $raw = (string) $zip->getFromName($name);

        $path = (string) tempnam(sys_get_temp_dir(), 'apkg');
        file_put_contents($path, $zstd && str_ends_with($name, 'b') ? zstd_uncompress($raw) : $raw);

        return new self($zip, $path, self::readMediaMap($zip, $zstd), $zstd);
    }

    /** The SQLite file, decompressed, as a path `pdo_sqlite` can open. */
    public function collectionPath(): string
    {
        return $this->collectionPath;
    }

    /** @return list<string> */
    public function mediaNames(): array
    {
        return array_map(strval(...), array_keys($this->media));
    }

    /** The bytes behind one media filename, decompressed if the deck is new-format. */
    public function media(string $name): ?string
    {
        $entry = $this->media[$name] ?? null;
        if ($entry === null) {
            return null;
        }

        $bytes = $this->zip->getFromName($entry);
        if ($bytes === false) {
            return null;
        }

        return $this->zstd ? zstd_uncompress($bytes) : $bytes;
    }

    public function close(): void
    {
        $this->zip->close();
        @unlink($this->collectionPath);
    }

    /**
     * Which numbered entry holds which filename.
     *
     * Anki stores media as `0`, `1`, `2`… with a manifest beside them, because
     * a zip cannot portably carry the filenames people actually use — a deck
     * from a Japanese collection has names no Windows build would agree to
     * unpack. The manifest is JSON in the legacy format and a protobuf message
     * in the new one, where the media files are individually zstd-compressed.
     *
     * @return array<string, string>
     */
    private static function readMediaMap(ZipArchive $zip, bool $zstd): array
    {
        $raw = $zip->getFromName('media');
        if ($raw === false || $raw === '') {
            return [];
        }

        $out = [];

        if (! $zstd) {
            /** @var array<string, string> $map */
            $map = json_decode($raw, true) ?: [];
            foreach ($map as $index => $filename) {
                if ($zip->locateName((string) $index) !== false) {
                    $out[(string) $filename] = (string) $index;
                }
            }

            return $out;
        }

        // MediaEntries { repeated MediaEntry entries = 1 }
        // MediaEntry   { string name = 1; uint32 size = 2; bytes sha1 = 3; }
        // The entries are positional: the nth one is the file named "n".
        foreach (Proto::bytes(Proto::decode(zstd_uncompress($raw)), 1) as $i => $entry) {
            $filename = Proto::string(Proto::decode($entry), 1);
            if ($filename !== '' && $zip->locateName((string) $i) !== false) {
                $out[$filename] = (string) $i;
            }
        }

        return $out;
    }
}
