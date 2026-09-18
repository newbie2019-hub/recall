<?php

namespace App\Support;

use App\Enums\ApiErrorCode;
use Illuminate\Http\JsonResponse;

/**
 * The two shapes every `/api/v1` response takes.
 *
 * PLAN.md §2.6 fixes both here because a phone cannot be force-updated. Lists
 * are enveloped rather than returned bare so that `next_cursor` has somewhere to
 * live and cannot be confused with a row, and so that `server_time` rides along
 * on every response — a client detects its own clock skew without spending a
 * request asking.
 */
final class ApiResponse
{
    /**
     * @param  array<string, mixed>  $extra
     */
    public static function data(mixed $data, array $extra = [], int $status = 200): JsonResponse
    {
        return response()->json([
            'data' => $data,
            ...$extra,
            'server_time' => now()->getTimestampMs(),
        ], $status);
    }

    /**
     * A page of rows, plus where to resume.
     *
     * `next_cursor` is null when the client is caught up, which is a different
     * statement from "no rows this time" — a page can be empty and still have a
     * cursor if the rows above it were filtered out.
     */
    public static function page(mixed $data, ?int $nextCursor): JsonResponse
    {
        return self::data($data, ['next_cursor' => $nextCursor]);
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    public static function error(ApiErrorCode $code, string $message, array $meta = []): JsonResponse
    {
        return response()->json([
            'error' => [
                'code' => $code->value,
                'message' => $message,
                ...($meta === [] ? [] : ['meta' => $meta]),
            ],
            'server_time' => now()->getTimestampMs(),
        ], $code->status());
    }
}
