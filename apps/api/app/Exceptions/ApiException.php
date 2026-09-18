<?php

namespace App\Exceptions;

use App\Enums\ApiErrorCode;
use App\Support\ApiResponse;
use Exception;
use Illuminate\Http\JsonResponse;

/**
 * An error the client is meant to branch on, as opposed to one it can only log.
 */
class ApiException extends Exception
{
    /**
     * Named `errorCode`, not `code`: `Exception` already declares an int `$code`
     * and PHP will not let a subclass redeclare it as a readonly enum.
     *
     * @param  array<string, mixed>  $meta
     */
    public function __construct(
        public readonly ApiErrorCode $errorCode,
        string $message = '',
        public readonly array $meta = [],
    ) {
        parent::__construct($message !== '' ? $message : $errorCode->value, $errorCode->status());
    }

    public function render(): JsonResponse
    {
        return ApiResponse::error($this->errorCode, $this->getMessage(), $this->meta);
    }
}
