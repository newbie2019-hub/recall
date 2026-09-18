<?php

namespace Tests\Unit\Anki;

use App\Services\Anki\Mapping;
use App\Services\Anki\Proto;
use PHPUnit\Framework\TestCase;

/**
 * The same cases as `packages/core/src/anki/anki.test.ts`, asserted against the
 * PHP port.
 *
 * Two importers over one mapping is the cost PHASES.md accepted for a
 * server-side import, and this file is what it bought: the fixtures are the
 * only thing that stops the two drifting, so each case here is deliberately the
 * same shape found in the wild as its TypeScript twin.
 */
class AnkiMappingTest extends TestCase
{
    public function test_protobuf_reads_the_fields_a_schema_18_template_config_holds(): void
    {
        // field 1 (qfmt) = "{{Front}}", field 5 (target deck) = 300, varint > 127.
        $blob = "\x0a\x09".'{{Front}}'."\x12\x02".'ab'."\x28\xac\x02";
        $message = Proto::decode($blob);

        $this->assertSame('{{Front}}', Proto::string($message, 1));
        $this->assertSame('ab', Proto::string($message, 2));
        $this->assertSame(300, Proto::int($message, 5));
        $this->assertSame(-1, Proto::int($message, 9, -1), 'an absent field is absent, not zero');

        // A blob we cannot read costs its own template, never the whole import.
        $this->assertSame([], Proto::decode("\xff"));
        $this->assertSame([], Proto::decode(null));
    }

    public function test_media_references_are_found_and_rewritten_and_left_alone_when_unknown(): void
    {
        $html = '<img src="heart%20left.png"> <img src=\'plain.jpg\'> <img src=bare.gif>'
            .' [sound:beat.mp3] <img src="https://x.test/a.png"> <img src="data:image/png;base64,AA">';

        $this->assertSame(
            ['heart left.png', 'plain.jpg', 'bare.gif', 'beat.mp3'],
            Mapping::mediaNames($html),
        );

        $out = Mapping::rewriteMedia($html, fn (string $n): ?string => $n === 'heart left.png' ? 'media/abc' : null);
        $this->assertStringContainsString('src="media/abc"', $out);
        $this->assertStringContainsString("src='plain.jpg'", $out, 'an unmapped name keeps its reference');
        $this->assertStringContainsString('src="https://x.test/a.png"', $out, 'remote images are not ours');
        $this->assertStringContainsString('[sound:beat.mp3]', $out);
        $this->assertStringContainsString(
            '[sound:media/z]',
            Mapping::rewriteMedia($html, fn (string $n): string => 'media/z'),
        );
    }

    public function test_anki_occlusion_shapes_map_onto_ours_centre_and_radius_included(): void
    {
        $field = '{{c1::image-occlusion:rect:left=10:top=20:width=30:height=40:oi=1}}<br>'
            .'{{c2::image-occlusion:ellipse:left=50:top=60:rx=10:ry=5}}<br>'
            .'{{c3::image-occlusion:polygon:points=0,0 100,0 50,50}}';

        $occlusion = Mapping::parseAnkiOcclusion($field);

        $this->assertSame('all', $occlusion['mode'], 'oi=1 means the other masks stay covered');
        $this->assertCount(3, $occlusion['shapes']);
        // Anki counts deletions from 1 and we count ordinals from 0.
        $this->assertSame([0, 1, 2], array_column($occlusion['shapes'], 'ord'));
        $this->assertSame(
            ['kind' => 'rect', 'ord' => 0, 'x' => 10.0, 'y' => 20.0, 'w' => 30.0, 'h' => 40.0],
            $occlusion['shapes'][0],
        );
        // Its ellipse is a centre and two radii; ours is a bounding box.
        $this->assertSame(
            ['kind' => 'ellipse', 'ord' => 1, 'x' => 40.0, 'y' => 55.0, 'w' => 20.0, 'h' => 10.0],
            $occlusion['shapes'][1],
        );

        $parsed = json_decode((string) Mapping::normaliseOcclusion($occlusion, 200, 100), true);
        $this->assertSame(
            ['kind' => 'rect', 'ord' => 0, 'x' => 0.05, 'y' => 0.2, 'w' => 0.15, 'h' => 0.4],
            $parsed['shapes'][0],
        );
        // Loose, because JSON has one number type: a normalised 0.0 comes back
        // as int 0 from `json_decode` exactly as it does from `JSON.parse`.
        $this->assertEquals([[0, 0], [0.5, 0], [0.25, 0.5]], $parsed['shapes'][2]['points']);

        // Unmeasurable image: say so rather than write coordinates that are a guess.
        $this->assertNull(Mapping::normaliseOcclusion($occlusion, 0, 100));
        $this->assertNull(Mapping::normaliseOcclusion(['mode' => 'one', 'shapes' => []], 10, 10));
    }
}
