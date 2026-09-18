<?php

namespace App\Http\Requests\Api\V1;

use App\Services\Sync\SyncService;
use Illuminate\Foundation\Http\FormRequest;

class SyncPullRequest extends FormRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'cursor' => ['sometimes', 'integer', 'min:0'],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:'.SyncService::MAX_ROWS],
        ];
    }

    public function cursor(): int
    {
        return (int) $this->input('cursor', 0);
    }

    public function limit(): int
    {
        return (int) $this->input('limit', SyncService::MAX_ROWS);
    }
}
