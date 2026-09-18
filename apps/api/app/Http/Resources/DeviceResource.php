<?php

namespace App\Http\Resources;

use App\Models\Device;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin Device */
class DeviceResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'platform' => $this->platform,
            'cursor' => $this->cursor,
            'last_seen_at' => $this->last_seen_at?->toIso8601String(),
            // So the account screen can say "this phone" rather than listing
            // five identical names and leaving the person to guess.
            'current' => $this->token_id !== null
                && $request->user()?->currentAccessToken()?->id === $this->token_id,
        ];
    }
}
