<?php

namespace App\Enums;

/**
 * Stable, machine-readable error codes.
 *
 * PLAN.md §2.6: an installed app cannot be force-updated, so an old build has to
 * branch on something that will never be reworded. The *message* is for a human
 * and may change in any release; the `value` here may not, ever. Adding a case
 * is free; renaming one breaks every phone in the field.
 */
enum ApiErrorCode: string
{
    case InvalidCredentials = 'invalid_credentials';
    case Unauthenticated = 'unauthenticated';
    case TokenExpired = 'token_expired';
    case Forbidden = 'forbidden';
    case NotFound = 'not_found';
    case ValidationFailed = 'validation_failed';
    case RateLimited = 'rate_limited';
    case PayloadTooLarge = 'payload_too_large';
    case ServerError = 'server_error';

    // Phase 10. Each one is a different thing for the client to *say*, which is
    // why they are separate codes rather than one `ai_error`: "turn it on in
    // Settings", "you have used this month's allowance" and "the model is
    // unreachable" lead to three different next actions.
    case AiUnavailable = 'ai_unavailable';
    case AiConsentRequired = 'ai_consent_required';
    case AiQuotaExceeded = 'ai_quota_exceeded';
    case AiRefused = 'ai_refused';
    case AiUpstream = 'ai_upstream';

    public function status(): int
    {
        return match ($this) {
            self::InvalidCredentials, self::Unauthenticated, self::TokenExpired => 401,
            self::Forbidden => 403,
            self::NotFound => 404,
            self::ValidationFailed => 422,
            self::PayloadTooLarge => 413,
            self::RateLimited => 429,
            self::ServerError => 500,
            self::AiConsentRequired => 403,
            // Payment Required, and meant literally: the allowance is spent.
            // Deliberately not 429 — a client that retries a rate limit must
            // not retry this, because waiting changes nothing until the period
            // rolls over.
            self::AiQuotaExceeded => 402,
            self::AiRefused => 422,
            self::AiUnavailable, self::AiUpstream => 503,
        };
    }
}
