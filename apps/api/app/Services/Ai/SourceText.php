<?php

declare(strict_types=1);

namespace App\Services\Ai;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use Smalot\PdfParser\Parser;

/**
 * A source document, as chunks of text a model can be asked about.
 *
 * Two jobs, and the second is the one that decides whether the cards are any
 * good. **Extraction** turns a PDF or a text file into prose; **chunking**
 * decides what the model sees at once — and a chunk that cuts a definition in
 * half produces exactly the "fragment of a fact with no standalone meaning"
 * card the grader is built to catch.
 *
 * So chunks break on blank lines first, sentences second, and only fall back to
 * a hard cut when a single paragraph is longer than the window. Overlap is
 * deliberate: a fact that straddles a boundary is otherwise visible to neither
 * side.
 */
final readonly class SourceText
{
    /**
     * Characters per chunk.
     *
     * Roughly 900 tokens, which is a comfortable amount of context for a model
     * asked to produce five or six prompts. Larger chunks produce fewer, vaguer
     * cards; smaller ones produce fragments.
     */
    public const CHUNK = 3_500;

    /** Carried from the end of each chunk into the next. */
    public const OVERLAP = 300;

    /** Anything past this is a book, not a handout. */
    public const MAX_CHARS = 400_000;

    /**
     * @return list<string>
     */
    public function chunks(string $text): array
    {
        $text = $this->normalise($text);

        if (mb_strlen($text) < 200) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'There is not enough readable text in that to make cards from.',
            );
        }

        $paragraphs = preg_split('/\n{2,}/u', $text) ?: [$text];
        $chunks = [];
        $current = '';

        foreach ($paragraphs as $paragraph) {
            $paragraph = trim($paragraph);
            if ($paragraph === '') {
                continue;
            }

            // A paragraph longer than the window is split on sentence ends
            // rather than mid-word — a chunk that starts halfway through a
            // clause is where fragment cards come from.
            if (mb_strlen($paragraph) > self::CHUNK) {
                foreach ($this->sentences($paragraph) as $piece) {
                    [$current, $chunks] = $this->append($current, $piece, $chunks);
                }

                continue;
            }

            [$current, $chunks] = $this->append($current, $paragraph, $chunks);
        }

        if (trim($current) !== '') {
            $chunks[] = trim($current);
        }

        return array_values(array_filter($chunks, fn (string $c): bool => mb_strlen(trim($c)) >= 120));
    }

    /**
     * Text out of an uploaded file.
     *
     * PDFs are read from their **text layer**. A scanned page has no text
     * layer, so it yields nothing — and rather than returning zero cards from a
     * job somebody paid to run, that is refused with the reason and the
     * suggestion that OCR is a different thing.
     */
    public function extract(string $path, string $name, string $mime): string
    {
        if (str_contains($mime, 'pdf') || str_ends_with(strtolower($name), '.pdf')) {
            return $this->fromPdf($path);
        }

        $text = @file_get_contents($path);

        if ($text === false) {
            throw new ApiException(ApiErrorCode::ValidationFailed, 'That file could not be read.');
        }

        // Anything that is not valid UTF-8 is a binary we have no extractor
        // for, and guessing at an encoding produces a prompt full of mojibake
        // that the model will dutifully make cards out of.
        if (! mb_check_encoding($text, 'UTF-8')) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'That file is not text. Upload a PDF, a .txt or a .md file.',
            );
        }

        return $text;
    }

    private function fromPdf(string $path): string
    {
        try {
            $text = (new Parser)->parseFile($path)->getText();
        } catch (\Throwable) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'That PDF could not be read. Password-protected files are not supported.',
            );
        }

        if (mb_strlen(trim($text)) < 200) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'That PDF has no text layer — it is probably a scan. Reading scanned pages needs OCR, which this does not do yet.',
            );
        }

        return $text;
    }

    /**
     * @param  list<string>  $chunks
     * @return array{0: string, 1: list<string>}
     */
    private function append(string $current, string $piece, array $chunks): array
    {
        if (mb_strlen($current) + mb_strlen($piece) + 2 <= self::CHUNK) {
            return [trim($current."\n\n".$piece), $chunks];
        }

        $chunks[] = trim($current);

        // The tail of the finished chunk leads the next one, so a fact that
        // straddles the boundary is visible to at least one of them whole.
        $tail = mb_substr($current, -self::OVERLAP);

        return [trim($tail."\n\n".$piece), $chunks];
    }

    /** @return list<string> */
    private function sentences(string $paragraph): array
    {
        $parts = preg_split('/(?<=[.!?])\s+/u', $paragraph) ?: [$paragraph];

        return array_values(array_filter(array_map('trim', $parts), fn (string $s): bool => $s !== ''));
    }

    /**
     * PDF text arrives with hard-wrapped lines, ligatures and page furniture.
     *
     * Joining a line that ends mid-sentence back onto the next is the single
     * highest-value clean-up: without it every chunk boundary and every prompt
     * is full of fragments, and the grader correctly rejects the lot.
     */
    private function normalise(string $text): string
    {
        $text = str_replace(["\r\n", "\r", "\u{00a0}"], ["\n", "\n", ' '], $text);
        $text = mb_substr($text, 0, self::MAX_CHARS);

        // A hyphen at a line end is a word split across lines.
        $text = preg_replace('/(\p{L})-\n(\p{L})/u', '$1$2', $text) ?? $text;
        // A line break that is not a paragraph break is a wrap.
        $text = preg_replace('/(?<![.!?:])\n(?!\n)/u', ' ', $text) ?? $text;
        $text = preg_replace('/[ \t]{2,}/u', ' ', $text) ?? $text;

        return trim($text);
    }
}
