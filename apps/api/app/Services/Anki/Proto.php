<?php

declare(strict_types=1);

namespace App\Services\Anki;

/**
 * Just enough protobuf to read Anki's schema-18 config blobs.
 *
 * The PHP twin of `packages/core/src/anki/proto.ts`, field number for field
 * number. Decoding the wire format needs no schema — a message is a flat list
 * of (field number, value) pairs — so this is a reader, not a compiler, and the
 * field numbers live with the code that knows what they mean.
 *
 * Varints come back as `int`, length-delimited and fixed-width fields as binary
 * strings, which is how the two are told apart downstream.
 */
final class Proto
{
    /**
     * Decode one message into field number → values.
     *
     * A blob that cannot be read yields an empty message rather than throwing:
     * one unreadable template must not cost the other 4,000 notes their import.
     *
     * @return array<int, list<int|string>>
     */
    public static function decode(?string $bytes): array
    {
        if ($bytes === null || $bytes === '') {
            return [];
        }

        $out = [];
        $len = strlen($bytes);
        $p = 0;

        try {
            while ($p < $len) {
                [$tag, $p] = self::varint($bytes, $p);
                $field = $tag >> 3;

                switch ($tag & 7) {
                    case 0:
                        [$value, $p] = self::varint($bytes, $p);
                        $out[$field][] = $value;
                        break;
                    case 1:
                        $out[$field][] = substr($bytes, $p, 8);
                        $p += 8;
                        break;
                    case 2:
                        [$size, $p] = self::varint($bytes, $p);
                        $out[$field][] = substr($bytes, $p, $size);
                        $p += $size;
                        break;
                    case 5:
                        $out[$field][] = substr($bytes, $p, 4);
                        $p += 4;
                        break;
                    default:
                        // Groups (3 and 4) are deprecated and Anki emits none.
                        return $out;
                }
            }
        } catch (\RuntimeException) {
            // Whatever was read before the damage is still worth having.
        }

        return $out;
    }

    /**
     * @param  array<int, list<int|string>>  $message
     */
    public static function string(array $message, int $field, string $fallback = ''): string
    {
        $value = $message[$field][0] ?? null;

        return is_string($value) ? $value : $fallback;
    }

    /**
     * @param  array<int, list<int|string>>  $message
     */
    public static function int(array $message, int $field, int $fallback = 0): int
    {
        $value = $message[$field][0] ?? null;

        return is_int($value) ? $value : $fallback;
    }

    /**
     * Every length-delimited value under one field number, which is how a
     * repeated submessage arrives.
     *
     * @param  array<int, list<int|string>>  $message
     * @return list<string>
     */
    public static function bytes(array $message, int $field): array
    {
        return array_values(array_filter($message[$field] ?? [], is_string(...)));
    }

    /**
     * @return array{0: int, 1: int} the value and the offset after it
     */
    private static function varint(string $bytes, int $at): array
    {
        $out = 0;
        $shift = 0;
        $len = strlen($bytes);

        // 10 bytes is the most a 64-bit varint can occupy; past that the blob is
        // corrupt and the loop would otherwise never end.
        for ($p = $at; $p < $len && $p - $at < 10; $p++) {
            $byte = ord($bytes[$p]);
            $out |= ($byte & 0x7F) << $shift;
            if (($byte & 0x80) === 0) {
                return [$out, $p + 1];
            }
            $shift += 7;
        }

        throw new \RuntimeException('Bad protobuf varint');
    }
}
