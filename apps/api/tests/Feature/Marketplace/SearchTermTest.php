<?php

declare(strict_types=1);

namespace Tests\Feature\Marketplace;

use App\Repositories\Eloquent\EloquentListingRepository;
use Tests\TestCase;

/**
 * Turning what somebody typed into a boolean-mode query.
 *
 * **This is the half of the FULLTEXT change the suite can actually test.** The
 * index itself only exists on MySQL and these tests run on SQLite, so the query
 * path is exercised in development and production and not here — but the string
 * that goes *into* it is pure, and it is also where the damage would be: `+`,
 * `-`, `*`, `(` and `"` are all operators in boolean mode, so a person typing
 * "anti-inflammatory" or "5' cap" would otherwise produce a syntax error, which
 * MySQL answers with an exception and the user sees as a 500 on a search box.
 */
class SearchTermTest extends TestCase
{
    public function test_each_word_is_required_and_prefix_matched(): void
    {
        // A marketplace search box is a prefix search in the reader's head,
        // whatever the index calls it: "anat" should find "anatomy".
        $this->assertSame('+cardiac* +anatomy*', EloquentListingRepository::booleanTerm('cardiac anatomy'));
        $this->assertSame('+anat*', EloquentListingRepository::booleanTerm('anat'));
    }

    public function test_operator_characters_are_stripped_not_obeyed(): void
    {
        // Somebody typing a hyphenated word means the word, not "NOT".
        $this->assertSame(
            '+anti* +inflammatory*',
            EloquentListingRepository::booleanTerm('anti-inflammatory'),
        );

        $this->assertSame('+cap*', EloquentListingRepository::booleanTerm('"cap"'));
        $this->assertSame('+heart*', EloquentListingRepository::booleanTerm('+heart'));
        $this->assertSame('+heart*', EloquentListingRepository::booleanTerm('heart*'));
    }

    public function test_a_query_that_is_only_operators_comes_back_empty(): void
    {
        // Rather than as a fragment MySQL would refuse. An empty boolean query
        // matches nothing, which is the right answer to a search for `***`.
        $this->assertSame('', EloquentListingRepository::booleanTerm('***'));
        $this->assertSame('', EloquentListingRepository::booleanTerm('   '));
        $this->assertSame('', EloquentListingRepository::booleanTerm('+-()~'));
    }

    public function test_extra_whitespace_does_not_produce_empty_terms(): void
    {
        // `+*` on its own is a syntax error in boolean mode.
        $this->assertSame('+a* +b*', EloquentListingRepository::booleanTerm("a \n\t  b "));
    }

    public function test_it_leaves_ordinary_unicode_alone(): void
    {
        $this->assertSame('+Ösophagus*', EloquentListingRepository::booleanTerm('Ösophagus'));
    }
}
