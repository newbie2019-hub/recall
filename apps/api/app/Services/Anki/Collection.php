<?php

declare(strict_types=1);

namespace App\Services\Anki;

use PDO;

/**
 * Reading an Anki collection — both schemas, one shape out. The PHP twin of
 * `packages/core/src/anki/read.ts`.
 *
 * Anki 2.1.50 moved note types and decks out of JSON blobs in the `col` table
 * into real tables with protobuf config columns, and called it schema 18. Both
 * are still in the wild: every shared deck published before 2022 is schema 11,
 * and every export made since is 18. The `notes`, `cards` and `revlog` tables
 * are identical in both, so only those two definitions fork.
 */
final class Collection
{
    /** `::` in schema 11, an ASCII unit separator in 18. */
    private const SEP_18 = "\x1f";

    public const FIELD_SEP = "\x1f";

    /** Anki's `StockNotetype.Kind`. Only image occlusion changes what we do. */
    private const STOCK_IMAGE_OCCLUSION = 5;

    private function __construct(private readonly PDO $pdo, private readonly int $schema) {}

    public static function open(string $path): self
    {
        $pdo = new PDO('sqlite:'.$path, options: [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);

        $notetypes = $pdo
            ->query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notetypes'")
            ->fetch();

        return new self($pdo, $notetypes ? 18 : 11);
    }

    public function schema(): int
    {
        return $this->schema;
    }

    /** Day zero for the collection, in milliseconds. */
    public function created(): int
    {
        return (int) ($this->one('SELECT crt FROM col LIMIT 1')['crt'] ?? 0) * 1000;
    }

    /**
     * Anki note type id → the note type as we model it.
     *
     * @return array<string, array<string, mixed>>
     */
    public function noteTypes(): array
    {
        return $this->schema === 18 ? $this->noteTypes18() : $this->noteTypes11();
    }

    /**
     * Anki deck id → its full path, always spelled with `::`.
     *
     * Schema 18 separates the components with an ASCII unit separator so that a
     * deck may legally contain "::" in its name; schema 11 uses "::" itself and
     * forbids it inside a name.
     *
     * @return array<string, string>
     */
    public function decks(): array
    {
        $out = [];

        if ($this->schema === 18) {
            foreach ($this->all('SELECT id, name FROM decks') as $row) {
                $out[(string) $row['id']] = str_replace(self::SEP_18, '::', (string) $row['name']);
            }

            return $out;
        }

        /** @var array<string, array<string, mixed>> $decks */
        $decks = json_decode((string) ($this->one('SELECT decks FROM col LIMIT 1')['decks'] ?? '{}'), true) ?: [];
        foreach ($decks as $did => $deck) {
            $out[(string) $did] = (string) ($deck['name'] ?? 'Imported');
        }

        return $out;
    }

    public function countNotes(): int
    {
        return (int) ($this->one('SELECT COUNT(*) AS n FROM notes')['n'] ?? 0);
    }

    /**
     * How many notes use `[latex]` blocks, which KaTeX cannot render.
     *
     * PHASES.md asks for the number rather than a decision: `\begin{tabular}`
     * and `tikz` need a real TeX run, and it is worth knowing whether that is
     * one deck in a hundred or one note in three.
     */
    public function countLatex(): int
    {
        $sql = "SELECT COUNT(*) AS n FROM notes WHERE flds LIKE '%[latex]%' OR flds LIKE '%[$%'";

        return (int) ($this->one($sql)['n'] ?? 0);
    }

    /**
     * @return list<array{id: int, guid: string, mid: string, tags: list<string>, fields: list<string>, mod: int}>
     */
    public function notes(int $limit, int $offset): array
    {
        $rows = $this->all(
            'SELECT id, guid, mid, tags, flds, mod FROM notes ORDER BY id LIMIT ? OFFSET ?',
            [$limit, $offset],
        );

        return array_map(fn (array $r): array => [
            'id' => (int) $r['id'],
            'guid' => (string) $r['guid'],
            'mid' => (string) $r['mid'],
            // Anki pads the tag string with a space at each end so
            // `LIKE '% tag %'` works; splitting on whitespace drops it for free.
            'tags' => array_values(array_filter(preg_split('/\s+/', (string) $r['tags']) ?: [])),
            'fields' => explode(self::FIELD_SEP, (string) $r['flds']),
            'mod' => (int) $r['mod'],
        ], $rows);
    }

    /**
     * @param  list<int>  $noteIds
     * @return list<array<string, int>>
     */
    public function cards(array $noteIds): array
    {
        if ($noteIds === []) {
            return [];
        }

        $rows = $this->all(
            'SELECT id, nid, did, odid, ord, type, queue, due, ivl FROM cards WHERE nid IN ('
                .implode(',', array_fill(0, count($noteIds), '?')).')',
            $noteIds,
        );

        return array_map(fn (array $r): array => array_map(intval(...), $r), $rows);
    }

    /**
     * The review log for a set of cards, oldest first.
     *
     * `type = 4` is a manual reschedule and `ease = 0` is a rescheduled or
     * reset entry — neither is an answer a person gave, and feeding them to
     * FSRS as one would invent a rating that never happened.
     *
     * @param  list<int>  $cardIds
     * @return list<array<string, int>>
     */
    public function reviews(array $cardIds): array
    {
        if ($cardIds === []) {
            return [];
        }

        $rows = $this->all(
            'SELECT id, cid, ease, time FROM revlog WHERE cid IN ('
                .implode(',', array_fill(0, count($cardIds), '?')).')'
                .' AND ease BETWEEN 1 AND 4 AND type != 4 ORDER BY id',
            $cardIds,
        );

        return array_map(fn (array $r): array => array_map(intval(...), $r), $rows);
    }

    /**
     * Schema 11: one JSON object in `col.models`, keyed by note type id.
     *
     * @return array<string, array<string, mixed>>
     */
    private function noteTypes11(): array
    {
        /** @var array<string, array<string, mixed>> $models */
        $models = json_decode((string) ($this->one('SELECT models FROM col LIMIT 1')['models'] ?? '{}'), true) ?: [];
        $out = [];

        foreach ($models as $mid => $model) {
            $flds = $model['flds'] ?? [];
            usort($flds, fn (array $a, array $b): int => ($a['ord'] ?? 0) <=> ($b['ord'] ?? 0));
            $fields = array_map(fn (array $f): string => (string) $f['name'], $flds);

            $tmpls = $model['tmpls'] ?? [];
            usort($tmpls, fn (array $a, array $b): int => ($a['ord'] ?? 0) <=> ($b['ord'] ?? 0));

            $out[(string) $mid] = [
                'id' => (string) $mid,
                'name' => (string) ($model['name'] ?? 'Imported'),
                'fields' => $fields,
                'templates' => array_map(fn (array $t): array => [
                    'name' => (string) ($t['name'] ?? ''),
                    'qfmt' => (string) ($t['qfmt'] ?? ''),
                    'afmt' => (string) ($t['afmt'] ?? ''),
                    // `did` is the template deck override, and it is an Anki
                    // deck id. The importer swaps it for ours once the decks
                    // exist.
                    'deckOverride' => empty($t['did']) ? null : (string) $t['did'],
                ], $tmpls),
                'css' => (string) ($model['css'] ?? ''),
                'kind' => self::kindOf(
                    (int) ($model['type'] ?? 0),
                    (int) ($model['originalStockKind'] ?? -1),
                    $fields,
                ),
                'ordField' => in_array('Occlusion', $fields, true) ? 'Occlusion' : null,
                'sortField' => self::clampSort((int) ($model['sortf'] ?? 0), $fields),
                'fieldConfig' => array_map(fn (array $f): array => [
                    'sticky' => (bool) ($f['sticky'] ?? false),
                    'rtl' => (bool) ($f['rtl'] ?? false),
                    'description' => ($f['description'] ?? '') ?: null,
                ], $flds),
                'ankiExtra' => [
                    'latexPre' => (string) ($model['latexPre'] ?? ''),
                    'latexPost' => (string) ($model['latexPost'] ?? ''),
                    'latexsvg' => (bool) ($model['latexsvg'] ?? false),
                    'originalStockKind' => (int) ($model['originalStockKind'] ?? -1),
                    'tmpls' => array_map(fn (array $t): array => [
                        'bqfmt' => (string) ($t['bqfmt'] ?? ''),
                        'bafmt' => (string) ($t['bafmt'] ?? ''),
                    ], $tmpls),
                ],
            ];
        }

        return $out;
    }

    /**
     * Schema 18: three tables, with the formats inside protobuf config blobs.
     *
     * @return array<string, array<string, mixed>>
     */
    private function noteTypes18(): array
    {
        $types = $this->all('SELECT id, name, config FROM notetypes');
        $fieldRows = $this->all('SELECT ntid, ord, name, config FROM fields ORDER BY ntid, ord');
        $tmplRows = $this->all('SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord');
        $out = [];

        foreach ($types as $type) {
            $config = Proto::decode((string) $type['config']);
            $mine = array_values(array_filter($fieldRows, fn (array $f): bool => $f['ntid'] == $type['id']));
            $fields = array_map(fn (array $f): string => (string) $f['name'], $mine);
            $tmpls = array_values(array_filter($tmplRows, fn (array $t): bool => $t['ntid'] == $type['id']));

            $out[(string) $type['id']] = [
                'id' => (string) $type['id'],
                'name' => (string) $type['name'],
                'fields' => $fields,
                'templates' => array_map(function (array $t): array {
                    $c = Proto::decode((string) $t['config']);
                    $did = Proto::int($c, 5);

                    return [
                        'name' => (string) $t['name'],
                        'qfmt' => Proto::string($c, 1),
                        'afmt' => Proto::string($c, 2),
                        'deckOverride' => $did === 0 ? null : (string) $did,
                    ];
                }, $tmpls),
                'css' => Proto::string($config, 3),
                'kind' => self::kindOf(Proto::int($config, 1), Proto::int($config, 9, -1), $fields),
                'ordField' => in_array('Occlusion', $fields, true) ? 'Occlusion' : null,
                'sortField' => self::clampSort(Proto::int($config, 2), $fields),
                'fieldConfig' => array_map(function (array $f): array {
                    $c = Proto::decode((string) $f['config']);

                    return [
                        'sticky' => Proto::int($c, 1) !== 0,
                        'rtl' => Proto::int($c, 2) !== 0,
                        'description' => Proto::string($c, 5) ?: null,
                    ];
                }, $mine),
                'ankiExtra' => [
                    'latexPre' => Proto::string($config, 5),
                    'latexPost' => Proto::string($config, 6),
                    'latexsvg' => Proto::int($config, 7) !== 0,
                    'originalStockKind' => Proto::int($config, 9, -1),
                    'tmpls' => array_map(function (array $t): array {
                        $c = Proto::decode((string) $t['config']);

                        return ['bqfmt' => Proto::string($c, 3), 'bafmt' => Proto::string($c, 4)];
                    }, $tmpls),
                ],
            ];
        }

        return $out;
    }

    /**
     * Which of our kinds an Anki note type is.
     *
     * `kind` is only ever normal or cloze — image occlusion is a cloze note
     * type wearing a stock-kind marker, because Anki generates its cards from
     * cloze ordinals in the `Occlusion` field. We model it as its own kind, so
     * the marker is the only thing that can tell us.
     *
     * @param  list<string>  $fields
     */
    private static function kindOf(int $kind, int $stock, array $fields): string
    {
        if ($stock === self::STOCK_IMAGE_OCCLUSION && in_array('Occlusion', $fields, true)) {
            return 'occlusion';
        }

        return $kind === 1 ? 'cloze' : 'standard';
    }

    /**
     * @param  list<string>  $fields
     */
    private static function clampSort(int $sortf, array $fields): int
    {
        return min(max(0, $sortf), max(0, count($fields) - 1));
    }

    /**
     * @param  list<mixed>  $params
     * @return list<array<string, mixed>>
     */
    private function all(string $sql, array $params = []): array
    {
        $statement = $this->pdo->prepare($sql);
        $statement->execute($params);

        return $statement->fetchAll();
    }

    /**
     * @return array<string, mixed>
     */
    private function one(string $sql): array
    {
        return $this->pdo->query($sql)->fetch() ?: [];
    }
}
