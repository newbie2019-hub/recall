<?php

declare(strict_types=1);

namespace App\Services\Anki;

/**
 * The two rewrites every imported note goes through: media filenames onto
 * content hashes, and Anki's image-occlusion syntax onto ours.
 *
 * The PHP twin of `packages/core/src/anki/media.ts`. Anki addresses media by
 * filename inside one flat folder; we address it by the sha256 of the bytes
 * (PLAN.md §2.6), so the import maps `heart.png` → `media/<hash>` once.
 *
 * Two importers over one mapping is the cost PHASES.md accepted, and
 * `tests/Unit/Anki/AnkiMappingTest.php` asserts the same cases as
 * `packages/core/src/anki/anki.test.ts` — that parity is what stops them
 * drifting.
 */
final class Mapping
{
    /** `<img src="x">`, `<audio src=x>` and the like. */
    private const SRC = '/\b(src|data)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))/i';

    private const SOUND = '/\[sound:([^\]]+)\]/';

    /** Anything already addressed — a data: URI, a remote image — is not ours. */
    private const ADDRESSED = '#^(https?:|data:|media/)#i';

    private const OCCLUSION = '/\{\{c(\d+)::image-occlusion:([a-z]+)([^}]*)\}\}/i';

    /**
     * Every media filename a note's fields refer to, in first-seen order.
     *
     * @return list<string>
     */
    public static function mediaNames(string $html): array
    {
        $names = [];

        if (preg_match_all(self::SRC, $html, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $match) {
                $raw = self::pick($match);
                if ($raw !== '' && preg_match(self::ADDRESSED, $raw) !== 1) {
                    $names[self::decodeName($raw)] = true;
                }
            }
        }

        if (preg_match_all(self::SOUND, $html, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $match) {
                $names[self::decodeName(trim($match[1]))] = true;
            }
        }

        // Cast back: PHP turns a key that looks like an integer into one, and
        // a file really can be called "42".
        return array_map(strval(...), array_keys($names));
    }

    /**
     * Swap every filename for what `$resolve` returns.
     *
     * A name with no mapping is left exactly as it was: a deck that shipped
     * without its media should render with a broken image where the image
     * belongs, not with the reference deleted.
     *
     * @param  callable(string): ?string  $resolve
     */
    public static function rewriteMedia(string $html, callable $resolve): string
    {
        $out = preg_replace_callback(self::SRC, function (array $match) use ($resolve): string {
            $raw = self::pick($match);
            if ($raw === '' || preg_match(self::ADDRESSED, $raw) === 1) {
                return $match[0];
            }
            $to = $resolve(self::decodeName($raw));

            return $to === null ? $match[0] : $match[1].'="'.$to.'"';
        }, $html) ?? $html;

        return preg_replace_callback(self::SOUND, function (array $match) use ($resolve): string {
            $to = $resolve(self::decodeName(trim($match[1])));

            return $to === null ? $match[0] : '[sound:'.$to.']';
        }, $out) ?? $out;
    }

    /**
     * Anki writes occlusion shapes as cloze deletions over a mini-language:
     *
     *   {{c1::image-occlusion:rect:left=10:top=20:width=30:height=40:oi=1}}
     *   {{c2::image-occlusion:ellipse:left=50:top=60:rx=10:ry=8}}
     *   {{c3::image-occlusion:polygon:points=10,20 30,40 50,60}}
     *
     * The numbers are pixels against the image's natural size, so they cannot
     * be used until the image has been measured — `normaliseOcclusion` is the
     * second half of this.
     *
     * @return array{mode: string, shapes: list<array<string, mixed>>}
     */
    public static function parseAnkiOcclusion(string $field): array
    {
        $shapes = [];
        $mode = 'one';

        if (preg_match_all(self::OCCLUSION, $field, $matches, PREG_SET_ORDER) === 0) {
            return ['mode' => $mode, 'shapes' => $shapes];
        }

        foreach ($matches as $match) {
            // Anki's ordinals are 1-based and ours are 0-based, the same offset
            // the cloze renderer already uses.
            $ord = (int) $match[1] - 1;
            if ($ord < 0) {
                continue;
            }
            $kind = strtolower($match[2]);
            $params = self::params($match[3] ?? '');

            // `oi=1` is "occlude inactive": every other mask stays covered too.
            if (($params['oi'] ?? '') === '1') {
                $mode = 'all';
            }

            if ($kind === 'polygon') {
                $points = [];
                foreach (preg_split('/\s+/', trim($params['points'] ?? '')) ?: [] as $pair) {
                    $parts = explode(',', $pair);
                    if (count($parts) === 2 && is_numeric($parts[0]) && is_numeric($parts[1])) {
                        $points[] = [(float) $parts[0], (float) $parts[1]];
                    }
                }
                if (count($points) > 2) {
                    $shapes[] = ['kind' => 'polygon', 'ord' => $ord, 'points' => $points];
                }

                continue;
            }

            if ($kind === 'ellipse') {
                // Anki's ellipse is a centre and two radii; ours is a bounding
                // box, which is what the SVG renderer and the editor's handles
                // both want.
                $rx = self::number($params['rx'] ?? null);
                $ry = self::number($params['ry'] ?? null);
                $shapes[] = [
                    'kind' => 'ellipse', 'ord' => $ord,
                    'x' => self::number($params['left'] ?? null) - $rx,
                    'y' => self::number($params['top'] ?? null) - $ry,
                    'w' => $rx * 2, 'h' => $ry * 2,
                ];

                continue;
            }

            $shapes[] = [
                'kind' => 'rect', 'ord' => $ord,
                'x' => self::number($params['left'] ?? null),
                'y' => self::number($params['top'] ?? null),
                'w' => self::number($params['width'] ?? null),
                'h' => self::number($params['height'] ?? null),
            ];
        }

        return ['mode' => $mode, 'shapes' => $shapes];
    }

    /**
     * Pixels → the 0–1 coordinates we store, so a mask survives the image being
     * re-encoded at another size.
     *
     * Null when the image could not be measured. The caller then leaves the
     * field alone and the card renders as the bare plate: a plate with no masks
     * is visibly wrong and recoverable, where masks at the wrong coordinates
     * look deliberate and are not.
     *
     * @param  array{mode: string, shapes: list<array<string, mixed>>}  $occlusion
     */
    public static function normaliseOcclusion(array $occlusion, int $width, int $height): ?string
    {
        if ($occlusion['shapes'] === [] || $width <= 0 || $height <= 0) {
            return null;
        }

        $shapes = array_map(function (array $shape) use ($width, $height): array {
            if ($shape['kind'] === 'polygon') {
                $shape['points'] = array_map(
                    fn (array $point): array => [$point[0] / $width, $point[1] / $height],
                    $shape['points'],
                );

                return $shape;
            }

            return [
                ...$shape,
                'x' => $shape['x'] / $width, 'y' => $shape['y'] / $height,
                'w' => $shape['w'] / $width, 'h' => $shape['h'] / $height,
            ];
        }, $occlusion['shapes']);

        return json_encode(['mode' => $occlusion['mode'], 'shapes' => $shapes], JSON_THROW_ON_ERROR);
    }

    /**
     * @param  array<int, string>  $match
     */
    private static function pick(array $match): string
    {
        foreach ([2, 3, 4] as $group) {
            if (($match[$group] ?? '') !== '') {
                return $match[$group];
            }
        }

        return '';
    }

    /**
     * `rawurldecode` rather than a strict decoder: a stray `%` in a filename is
     * legal on disk and not valid percent-encoding, and dropping such a note's
     * image is worse than leaving the name as it was written.
     */
    private static function decodeName(string $raw): string
    {
        return rawurldecode($raw);
    }

    /**
     * @return array<string, string>
     */
    private static function params(string $rest): array
    {
        $out = [];
        foreach (explode(':', $rest) as $part) {
            if ($part === '') {
                continue;
            }
            $at = strpos($part, '=');
            if ($at === false) {
                $out[trim($part)] = '';

                continue;
            }
            $out[trim(substr($part, 0, $at))] = trim(substr($part, $at + 1));
        }

        return $out;
    }

    private static function number(?string $value): float
    {
        return is_numeric($value) ? (float) $value : 0.0;
    }
}
