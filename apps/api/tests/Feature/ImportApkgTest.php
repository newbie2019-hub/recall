<?php

namespace Tests\Feature;

use App\Jobs\ImportApkgJob;
use App\Models\Deck;
use App\Models\ImportJob;
use App\Models\MediaFile;
use App\Models\Note;
use App\Models\NoteType;
use App\Models\Review;
use App\Models\User;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use PDO;
use Tests\TestCase;
use ZipArchive;

/**
 * Upload → queue → unzip → read → write, against a real `.apkg` built here.
 *
 * Both containers are built here, because both are in the wild and they share
 * almost nothing: schema 11 keeps its note types as JSON in `col`, and schema 18
 * keeps them in protobuf blobs inside a zstd-compressed collection, with the
 * media manifest compressed separately again.
 */
class ImportApkgTest extends TestCase
{
    use RefreshDatabase;

    private const PASSWORD = 'thoracic-aorta-lecture-notes';

    /** Long before the product existed, which is the point: an .apkg carries history. */
    private const ANSWERED_AT = 1_500_000_000_000;

    private User $user;

    private string $token;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake();
        $this->user = User::factory()->create(['password' => self::PASSWORD]);
        $this->token = $this->tokenFor($this->user);
    }

    public function test_an_upload_is_queued_rather_than_imported_in_the_request(): void
    {
        Queue::fake();

        $response = $this->upload()->assertCreated();

        Queue::assertPushed(ImportApkgJob::class);
        $this->assertSame('queued', $response->json('data.status'));
        $this->assertSame(0, Note::query()->count(), 'nothing is written before the worker runs');
    }

    public function test_an_import_lands_notes_decks_media_and_history_in_the_account(): void
    {
        $response = $this->upload()->assertCreated();
        $report = $this->poll($response->json('data.id'));

        $this->assertSame('done', $report['status']);
        $this->assertSame(2, $report['report']['notes_added']);
        $this->assertSame(0, $report['report']['notes_updated']);
        $this->assertSame(2, $report['report']['reviews']);

        // The deck tree is split on `::`, not stored as one flat name.
        $thorax = Deck::query()->where('name', 'Thorax')->first();
        $this->assertNotNull($thorax);
        $this->assertSame('Anatomy', Deck::query()->find($thorax->parent_id)->name);

        $sha = hash('sha256', $this->png());
        $this->assertDatabaseHas('media', ['user_id' => $this->user->id, 'sha256' => $sha]);
        Storage::assertExists("media/{$this->user->id}/{$sha}");

        // Media references are rewritten onto the content hash, so the same
        // diagram in twenty decks is stored once.
        $basic = Note::query()->where('guid', 'guid-basic')->firstOrFail();
        $this->assertStringContainsString("media/{$sha}", $basic->fields['Front']);
        $this->assertSame($thorax->id, $basic->deck_id, 'the card\'s own deck wins over the default');
    }

    public function test_only_answers_a_person_gave_become_reviews_and_they_keep_their_own_time(): void
    {
        $this->poll($this->upload()->json('data.id'));

        $reviews = Review::query()->orderBy('client_ts')->get();

        // The revlog fixture holds four rows: two answers, one `ease = 0`
        // reschedule and one `type = 4` manual set. Only the answers are real.
        $this->assertCount(2, $reviews);
        $this->assertSame([3, 4], $reviews->pluck('rating')->map(intval(...))->all());
        $this->assertTrue((bool) $reviews->first()->imported);

        // Not clamped forward to the product's epoch: a collection carries
        // answers from years before this existed, and compressing them onto one
        // afternoon would be a lie about when the studying happened.
        $this->assertSame(self::ANSWERED_AT, (int) $reviews->first()->client_ts);

        // `<note id>:<ord>` — README rule 2, and what every device derives its
        // scheduling from once it pulls these rows.
        $note = Note::query()->where('guid', 'guid-basic')->firstOrFail();
        $this->assertSame("{$note->id}:0", $reviews->first()->card_id);
    }

    public function test_an_occlusion_note_is_measured_and_its_masks_normalised(): void
    {
        $this->poll($this->upload()->json('data.id'));

        $note = Note::query()->where('guid', 'guid-occlusion')->firstOrFail();
        $occlusion = json_decode($note->fields['Occlusion'], true);

        // The fixture image is 200×100 and the mask is at 10,20 sized 30×40.
        $this->assertSame('one', $occlusion['mode']);
        $this->assertEqualsWithDelta(0.05, $occlusion['shapes'][0]['x'], 1e-9);
        $this->assertEqualsWithDelta(0.2, $occlusion['shapes'][0]['y'], 1e-9);
        $this->assertEqualsWithDelta(0.15, $occlusion['shapes'][0]['w'], 1e-9);
        $this->assertEqualsWithDelta(0.4, $occlusion['shapes'][0]['h'], 1e-9);
    }

    public function test_importing_the_same_deck_twice_updates_and_does_not_double_the_log(): void
    {
        $this->poll($this->upload()->json('data.id'));
        $report = $this->poll($this->upload()->json('data.id'));

        $this->assertSame(2, $report['report']['notes_updated']);
        $this->assertSame(0, $report['report']['notes_added'], 'guid is the identity, not the row id');
        $this->assertSame(0, $report['report']['reviews'], 'an answer is its card and its instant');
        $this->assertSame(2, Note::query()->count());
        $this->assertSame(2, Review::query()->count());
        $this->assertSame(1, MediaFile::query()->count());
    }

    public function test_a_job_belongs_to_the_account_that_started_it(): void
    {
        $id = $this->upload()->json('data.id');
        $other = User::factory()->create(['password' => self::PASSWORD]);

        $this->actingAsToken($this->tokenFor($other))
            ->getJson("/api/v1/imports/{$id}")
            ->assertNotFound()
            ->assertJsonPath('error.code', 'not_found');
    }

    public function test_a_file_that_is_not_a_deck_fails_the_job_rather_than_the_request(): void
    {
        $response = $this->actingAsToken($this->token)->postJson('/api/v1/imports', [
            'file' => UploadedFile::fake()->createWithContent('notes.apkg', 'not a zip at all'),
        ])->assertCreated();

        $job = ImportJob::query()->findOrFail($response->json('data.id'));
        $this->assertSame('failed', $job->status);
        $this->assertNotNull($job->error);
        // The upload is gone either way; a failed 200 MB import must not keep
        // its file.
        Storage::assertMissing($job->path);
    }

    public function test_a_schema_18_deck_reads_its_note_types_out_of_protobuf_blobs(): void
    {
        $response = $this->actingAsToken($this->token)->postJson('/api/v1/imports', [
            'file' => UploadedFile::fake()->createWithContent('modern.apkg', $this->apkg18()),
        ])->assertCreated();

        $job = $this->poll($response->json('data.id'));
        $this->assertSame('done', $job['status'], (string) ($job['error'] ?? ''));

        // Everything asserted here lived in a JSON blob in schema 11 and lives
        // in a protobuf `config` column in 18: the formats, the CSS, and the
        // separator the deck tree is spelled with.
        $type = NoteType::query()->findOrFail('anki:1000');
        $this->assertSame(['Front', 'Back'], $type->fields);
        $this->assertSame('{{Front}}', $type->templates[0]['qfmt']);
        $this->assertSame('.card { color: teal }', $type->css);
        $this->assertSame('Thorax', Deck::query()->where('name', 'Thorax')->firstOrFail()->name);

        // The media manifest is a zstd-compressed protobuf here, and each file
        // is compressed on its own.
        $note = Note::query()->where('guid', 'guid-18')->firstOrFail();
        $this->assertStringContainsString('media/'.hash('sha256', $this->png()), $note->fields['Front']);
    }

    private function tokenFor(User $user): string
    {
        return app(AuthService::class)
            ->login($user->email, self::PASSWORD, new DeviceIdentity('iPhone'))['token']
            ->plainTextToken;
    }

    private function upload(): TestResponse
    {
        return $this->actingAsToken($this->token)->postJson('/api/v1/imports', [
            'file' => UploadedFile::fake()->createWithContent('anatomy.apkg', $this->apkg()),
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function poll(string $id): array
    {
        return $this->actingAsToken($this->token)
            ->getJson("/api/v1/imports/{$id}")
            ->assertOk()
            ->json('data');
    }

    /** A 200×100 PNG, so the occlusion coordinates have something to divide by. */
    private function png(): string
    {
        $image = imagecreatetruecolor(200, 100);
        ob_start();
        imagepng($image);

        return (string) ob_get_clean();
    }

    /** A schema-11 `.apkg`: one collection, one media manifest, one image. */
    private function apkg(): string
    {
        $collection = tempnam(sys_get_temp_dir(), 'col');
        $this->writeCollection($collection);

        $path = tempnam(sys_get_temp_dir(), 'apkg');
        $zip = new ZipArchive;
        $zip->open($path, ZipArchive::OVERWRITE);
        $zip->addFromString('collection.anki2', (string) file_get_contents($collection));
        $zip->addFromString('media', '{"0":"heart.png"}');
        $zip->addFromString('0', $this->png());
        $zip->close();

        $bytes = (string) file_get_contents($path);
        unlink($collection);
        unlink($path);

        return $bytes;
    }

    /**
     * A schema-18 `.apkg`: zstd-compressed collection, protobuf media manifest,
     * and note types whose formats live in `config` blobs.
     */
    private function apkg18(): string
    {
        $collection = tempnam(sys_get_temp_dir(), 'col18');
        $this->writeCollection18($collection);

        $path = tempnam(sys_get_temp_dir(), 'apkg18');
        $zip = new ZipArchive;
        $zip->open($path, ZipArchive::OVERWRITE);
        $zip->addFromString('collection.anki21b', zstd_compress((string) file_get_contents($collection)));
        // MediaEntries { repeated MediaEntry entries = 1 }, entry 0 = heart.png.
        $zip->addFromString('media', zstd_compress($this->field(1, $this->field(1, 'heart.png'))));
        $zip->addFromString('0', zstd_compress($this->png()));
        // The deliberately empty 2.0 collection a real export ships beside it,
        // which the reader has to pass over in favour of the newest entry.
        $zip->addFromString('collection.anki2', '');
        $zip->close();

        $bytes = (string) file_get_contents($path);
        unlink($collection);
        unlink($path);

        return $bytes;
    }

    private function writeCollection18(string $path): void
    {
        $pdo = new PDO('sqlite:'.$path, options: [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE col (id integer PRIMARY KEY, crt integer, mod integer, scm integer,
            ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text,
            dconf text, tags text)');
        $pdo->exec('CREATE TABLE notetypes (id integer PRIMARY KEY, name text, mtime_secs integer,
            usn integer, config blob)');
        $pdo->exec('CREATE TABLE fields (ntid integer, ord integer, name text, config blob)');
        $pdo->exec('CREATE TABLE templates (ntid integer, ord integer, name text, mtime_secs integer,
            usn integer, config blob)');
        $pdo->exec('CREATE TABLE decks (id integer PRIMARY KEY, name text, mtime_secs integer,
            usn integer, common blob, kind blob)');
        $pdo->exec('CREATE TABLE notes (id integer PRIMARY KEY, guid text, mid integer, mod integer,
            usn integer, tags text, flds text, sfld integer, csum integer, flags integer, data text)');
        $pdo->exec('CREATE TABLE cards (id integer PRIMARY KEY, nid integer, did integer, ord integer,
            mod integer, usn integer, type integer, queue integer, due integer, ivl integer,
            factor integer, reps integer, lapses integer, left integer, odue integer, odid integer,
            flags integer, data text)');
        $pdo->exec('CREATE TABLE revlog (id integer PRIMARY KEY, cid integer, usn integer, ease integer,
            ivl integer, lastIvl integer, factor integer, time integer, type integer)');

        $pdo->prepare('INSERT INTO col VALUES (1, ?, 0, 0, 18, 0, 0, 0, ?, ?, ?, ?, ?)')
            ->execute([1_400_000_000, '{}', '{}', '{}', '{}', '{}']);

        // NotetypeConfig { kind = 1, sort_field_idx = 2, css = 3 }
        $pdo->prepare('INSERT INTO notetypes VALUES (1000, ?, 0, 0, ?)')
            ->execute(['Basic', $this->varint(1, 0).$this->varint(2, 0).$this->field(3, '.card { color: teal }')]);
        $fields = $pdo->prepare('INSERT INTO fields VALUES (1000, ?, ?, ?)');
        $fields->execute([0, 'Front', '']);
        $fields->execute([1, 'Back', '']);
        // CardTemplateConfig { q_format = 1, a_format = 2, target_deck_id = 5 }
        $pdo->prepare('INSERT INTO templates VALUES (1000, 0, ?, 0, 0, ?)')
            ->execute(['Card 1', $this->field(1, '{{Front}}').$this->field(2, '{{Back}}')]);

        // Schema 18 separates deck components with a unit separator, so that a
        // deck name may legally contain "::".
        $pdo->prepare('INSERT INTO decks VALUES (3000, ?, 0, 0, ?, ?)')
            ->execute(["Anatomy\x1fThorax", '', '']);

        $pdo->prepare('INSERT INTO notes VALUES (1, ?, 1000, ?, 0, \'\', ?, 0, 0, 0, \'\')')
            ->execute(['guid-18', 1_600_000_000, '<img src="heart.png">'."\x1f".'The left atrium']);
        $pdo->prepare('INSERT INTO cards VALUES (11, 1, 3000, 0, 0,0,0,0,0,0,0,0,0,0,0,0,0,\'\')')
            ->execute();
    }

    /** One length-delimited protobuf field: tag byte, length, payload. */
    private function field(int $number, string $payload): string
    {
        return chr($number << 3 | 2).chr(strlen($payload)).$payload;
    }

    /** One varint protobuf field, single-byte values only — enough for a fixture. */
    private function varint(int $number, int $value): string
    {
        return chr($number << 3).chr($value);
    }

    private function writeCollection(string $path): void
    {
        $pdo = new PDO('sqlite:'.$path, options: [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE col (id integer PRIMARY KEY, crt integer, mod integer, scm integer,
            ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text,
            dconf text, tags text)');
        $pdo->exec('CREATE TABLE notes (id integer PRIMARY KEY, guid text, mid integer, mod integer,
            usn integer, tags text, flds text, sfld integer, csum integer, flags integer, data text)');
        $pdo->exec('CREATE TABLE cards (id integer PRIMARY KEY, nid integer, did integer, ord integer,
            mod integer, usn integer, type integer, queue integer, due integer, ivl integer,
            factor integer, reps integer, lapses integer, left integer, odue integer, odid integer,
            flags integer, data text)');
        $pdo->exec('CREATE TABLE revlog (id integer PRIMARY KEY, cid integer, usn integer, ease integer,
            ivl integer, lastIvl integer, factor integer, time integer, type integer)');

        $models = [
            '1000' => [
                'name' => 'Basic', 'type' => 0, 'sortf' => 0, 'css' => '.card {}',
                'flds' => [['name' => 'Front', 'ord' => 0], ['name' => 'Back', 'ord' => 1]],
                'tmpls' => [['name' => 'Card 1', 'ord' => 0, 'qfmt' => '{{Front}}', 'afmt' => '{{Back}}']],
                'latexPre' => '\\usepackage{amsmath}',
            ],
            '2000' => [
                'name' => 'Image Occlusion', 'type' => 1, 'sortf' => 0, 'css' => '',
                'originalStockKind' => 5,
                'flds' => [['name' => 'Occlusion', 'ord' => 0], ['name' => 'Image', 'ord' => 1]],
                'tmpls' => [['name' => 'Card 1', 'ord' => 0, 'qfmt' => '{{Occlusion}}', 'afmt' => '{{Image}}']],
            ],
        ];
        $decks = ['1' => ['name' => 'Default'], '3000' => ['name' => 'Anatomy::Thorax']];

        $pdo->prepare('INSERT INTO col VALUES (1, ?, 0, 0, 11, 0, 0, 0, ?, ?, ?, ?, ?)')->execute([
            1_400_000_000, '{}', json_encode($models), json_encode($decks), '{}', '{}',
        ]);

        $sep = "\x1f";
        $notes = $pdo->prepare('INSERT INTO notes VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, 0, \'\')');
        $notes->execute([1, 'guid-basic', 1000, 1_600_000_000, ' thorax anatomy ',
            '<img src="heart.png">'.$sep.'The left atrium']);
        $notes->execute([2, 'guid-occlusion', 2000, 1_600_000_000, '',
            '{{c1::image-occlusion:rect:left=10:top=20:width=30:height=40}}'.$sep.'<img src="heart.png">']);

        $cards = $pdo->prepare('INSERT INTO cards VALUES (?, ?, ?, ?, 0,0,0,0,0,0,0,0,0,0,0, ?, 0, \'\')');
        $cards->execute([11, 1, 3000, 0, 0]);
        $cards->execute([12, 2, 1, 0, 0]);

        $revlog = $pdo->prepare('INSERT INTO revlog VALUES (?, ?, 0, ?, 0, 0, 0, ?, ?)');
        $revlog->execute([self::ANSWERED_AT, 11, 3, 4200, 1]);
        $revlog->execute([self::ANSWERED_AT + 86_400_000, 11, 4, 1800, 1]);
        // Neither of these is an answer a person gave.
        $revlog->execute([self::ANSWERED_AT + 90_000_000, 11, 0, 0, 0]);
        $revlog->execute([self::ANSWERED_AT + 95_000_000, 11, 3, 0, 4]);
    }
}
