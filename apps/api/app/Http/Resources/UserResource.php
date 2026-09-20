<?php

namespace App\Http\Resources;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin User */
class UserResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'email' => $this->email,
            'email_verified' => $this->email_verified_at !== null,
            // The app chrome needs it to know whether to offer the queue at
            // all. Authorization is still the policy's — this only decides
            // whether a link is drawn, never whether the call is allowed.
            'is_moderator' => (bool) $this->is_moderator,
        ];
    }
}
