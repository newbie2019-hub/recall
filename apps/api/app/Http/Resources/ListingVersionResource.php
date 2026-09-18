<?php

declare(strict_types=1);

namespace App\Http\Resources;

use App\Models\ListingVersion;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin ListingVersion
 */
class ListingVersionResource extends JsonResource
{
    private bool $includePayload = false;

    /**
     * The download. Separate from the default shape because a client asking
     * "what versions exist?" wants a list it can render, not several megabytes
     * of notes per entry.
     */
    public static function withPayload(ListingVersion $version): self
    {
        $resource = new self($version);
        $resource->includePayload = true;

        return $resource;
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'version' => $this->version,
            'semver' => $this->semver,
            'changelog' => $this->changelog,
            'note_count' => $this->note_count,
            'size_bytes' => $this->size_bytes,
            'checksum' => $this->checksum,
            'rights_attestation' => $this->rights_attestation,
            'published_at' => $this->created_at?->toIso8601String(),
            ...($this->includePayload
                ? ['payload' => json_decode($this->payload, true, 512, JSON_THROW_ON_ERROR)]
                : []),
        ];
    }
}
