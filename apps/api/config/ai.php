<?php

declare(strict_types=1);

/**
 * Prices, plans and the switch that turns the whole subsystem off.
 *
 * **Prices live in config, not in rows** (AI.md §4): a price change is a deploy,
 * not a migration across every user. What *is* stored per call is the
 * `version` below, so a ledger row can always be re-audited against the table
 * that produced it — a ledger holding only dollars cannot answer "what did we
 * charge in March", and one holding only tokens cannot answer "what did it
 * cost".
 *
 * Rates are **micro-dollars per token**, integer throughout. Dollars per million
 * tokens divided by a million is a float, and a float is how a billing total
 * drifts from the console by a cent a month until somebody has to reconcile it.
 */
return [
    /**
     * No key, no subsystem. Every AI affordance in the app checks this, so a
     * deployment without a key is a working app with the feature absent rather
     * than an app that fails when someone presses the button.
     */
    'key' => env('ANTHROPIC_API_KEY'),

    'base_url' => env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),

    'version' => env('ANTHROPIC_VERSION', '2023-06-01'),

    /** Seconds. A model that has not answered by now is not going to. */
    'timeout' => (int) env('ANTHROPIC_TIMEOUT', 60),

    /**
     * Which table produced a `cost_micros`. Bump it whenever `prices` changes;
     * the old rows keep the old string and stay auditable.
     */
    'price_version' => '2026-09',

    /**
     * Micro-dollars per token.
     *
     * The two multipliers are Anthropic's: a cache write costs 1.25× the input
     * rate and a cache read costs 0.10×. They are written here rather than
     * inlined so the arithmetic in `Pricing` has exactly one source.
     */
    'cache_write_multiplier' => 1.25,
    'cache_read_multiplier' => 0.10,

    'prices' => [
        // Generation, explanation, briefing. A product decision, not a default:
        // the benchmark says models are weakest at exactly the thing this is
        // asked to do (AI.md §3.3).
        'claude-opus-5' => ['input' => 5, 'output' => 25],
        // The grader. An LLM judge is the sanctioned place for a cheaper model.
        'claude-haiku-4-5-20251001' => ['input' => 1, 'output' => 5],
        'claude-sonnet-5' => ['input' => 2, 'output' => 10],
    ],

    'models' => [
        'explain' => env('ANTHROPIC_MODEL_EXPLAIN', 'claude-opus-5'),
        'grade' => env('ANTHROPIC_MODEL_GRADE', 'claude-haiku-4-5-20251001'),
        'generate' => env('ANTHROPIC_MODEL_GENERATE', 'claude-opus-5'),
        'brief' => env('ANTHROPIC_MODEL_BRIEF', 'claude-opus-5'),
    ],

    /**
     * Monthly allowance per plan, in micro-dollars.
     *
     * Free is deliberately small and deliberately honest: roughly two hundred
     * lapse explanations, or one forty-page PDF with room to spare.
     */
    'plans' => [
        'free' => ['limit_micros' => 250_000],   // $0.25
        'pro' => ['limit_micros' => 5_000_000],  // $5.00
    ],
];
