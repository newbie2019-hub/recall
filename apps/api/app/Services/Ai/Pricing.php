<?php

declare(strict_types=1);

namespace App\Services\Ai;

/**
 * Tokens into micro-dollars.
 *
 * Small enough to read in one go, and separated from the gateway on purpose:
 * this is the arithmetic that has to be right, and it is the arithmetic that is
 * easy to get silently wrong. AI.md §6.5 names the trap — **`usage.input_tokens`
 * excludes cached tokens.** Adding the cache counts to it double-charges;
 * leaving them out entirely under-charges a cached workload by most of its bill.
 * Both mistakes are invisible until an accountant finds them.
 *
 * Integer micro-dollars throughout. A float total drifts from the console by a
 * cent a month, which is exactly long enough for nobody to notice until the
 * reconciliation.
 */
final readonly class Pricing
{
    /**
     * @param  array{input?: int, output?: int}|null  $rate  micro-dollars per token
     */
    public static function cost(
        string $model,
        int $inputTokens,
        int $cacheWriteTokens,
        int $cacheReadTokens,
        int $outputTokens,
        ?array $rate = null,
    ): int {
        $rate ??= config("ai.prices.{$model}");

        // An unpriced model still gets a ledger row — with a zero cost and the
        // token counts intact, so the call is visible and the bill can be
        // recomputed once the price table catches up. Silently skipping the row
        // would be the one outcome worse than a wrong number.
        if (! $rate) {
            return 0;
        }

        $input = (int) $rate['input'];
        $output = (int) $rate['output'];

        $write = $input * (float) config('ai.cache_write_multiplier', 1.25);
        $read = $input * (float) config('ai.cache_read_multiplier', 0.10);

        // Rounded once, at the end. Rounding each line item lets four
        // half-micro errors become two micro-dollars on a long conversation.
        return (int) round(
            $inputTokens * $input
            + $cacheWriteTokens * $write
            + $cacheReadTokens * $read
            + $outputTokens * $output
        );
    }

    /** For the UI. `$0.0315` reads as a price; `31500` reads as a bug. */
    public static function dollars(int $micros): string
    {
        return '$'.number_format($micros / 1_000_000, 4);
    }
}
