<?php

namespace App\Http\Controllers\Concerns;

use App\Support\ApiResponse;
use Illuminate\Http\JsonResponse;

/**
 * The envelope, reachable from any controller without importing the support
 * class into every one of them.
 */
trait RespondsWithApi
{
    /**
     * @param  array<string, mixed>  $extra
     */
    protected function ok(mixed $data, array $extra = [], int $status = 200): JsonResponse
    {
        return ApiResponse::data($data, $extra, $status);
    }

    protected function created(mixed $data): JsonResponse
    {
        return ApiResponse::data($data, status: 201);
    }

    /**
     * A page, and the cursor for the next one.
     *
     * The cursor is **opaque to the client**: an integer where it is an offset
     * or a revision, a `<timestamp>|<id>` string where the list is keyset-paged
     * and an offset would re-show rows as new ones arrive above them. Callers
     * hand it back exactly as they received it and never do arithmetic on it.
     */
    protected function page(mixed $data, int|string|null $nextCursor, bool $hasMore): JsonResponse
    {
        return ApiResponse::data($data, ['next_cursor' => $nextCursor, 'has_more' => $hasMore]);
    }
}
