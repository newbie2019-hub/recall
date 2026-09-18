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

    protected function page(mixed $data, ?int $nextCursor, bool $hasMore): JsonResponse
    {
        return ApiResponse::data($data, ['next_cursor' => $nextCursor, 'has_more' => $hasMore]);
    }
}
