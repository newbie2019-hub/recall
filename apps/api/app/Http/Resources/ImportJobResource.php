<?php

namespace App\Http\Resources;

use App\Models\ImportJob;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin ImportJob */
class ImportJobResource extends JsonResource
{
    /**
     * What a poll answers: where the import got to, and what it did.
     *
     * `report` is null until the job finishes, and `error` is null unless it
     * failed — a client that sees `status: "failed"` has the reason in the same
     * response rather than a second request later.
     *
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'file' => $this->original_name,
            'status' => $this->status,
            'stage' => $this->stage,
            'done' => $this->done,
            'total' => $this->total,
            'report' => $this->report,
            'error' => $this->error,
            'created_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
