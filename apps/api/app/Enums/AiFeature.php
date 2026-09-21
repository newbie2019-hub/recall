<?php

declare(strict_types=1);

namespace App\Enums;

/**
 * Every reason this application talks to Anthropic.
 *
 * AI.md §3.1: there is exactly one code path to the API and it cannot return
 * without writing a ledger row. This enum is what makes adding a new caller a
 * **compiler-visible act** — a feature that wants the model adds a case here,
 * which is a line in a diff somebody reviews, rather than a new `Http::post`
 * somewhere that never reaches the meter.
 */
enum AiFeature: string
{
    /** One lapse, explained. The cheapest call in the product. */
    case Explain = 'explain';

    /** The rubric, over candidates or over cards you already have. */
    case Grade = 'grade';

    /** Source text into candidate cards. */
    case Generate = 'generate';

    /** Two paragraphs over weakness numbers the model is *given*. */
    case Brief = 'brief';

    /**
     * The grader's missing half: a card rewritten as a suggestion.
     *
     * Separate from `Grade` rather than folded into it, because the two have
     * different models, different costs and different risks — grading is a
     * cheap judgement over twenty cards, rewriting is one card and puts words
     * in somebody's collection. They are also separate lines in the meter,
     * which is the only way "why did my allowance go" has an answer.
     */
    case Rewrite = 'rewrite';

    /** Which model config picked for this feature. */
    public function model(): string
    {
        return (string) config("ai.models.{$this->value}");
    }
}
