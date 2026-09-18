<?php

declare(strict_types=1);

namespace App\Http\Resources;

use App\Models\Listing;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin Listing
 */
class ListingResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $viewer = $request->user();
        $privileged = $viewer !== null && ($viewer->id === $this->user_id || $viewer->is_moderator);

        return [
            'id' => $this->id,
            'title' => $this->title,
            'description' => $this->description,
            // A partial select (the moderation queue takes a few columns) leaves
            // this null rather than empty, and a resource may not fatal on that.
            'tags' => ((string) $this->tags) === '' ? [] : explode(' ', (string) $this->tags),
            'visibility' => $this->visibility,
            'latest_version' => $this->latest_version,
            'install_count' => $this->install_count,
            'published_at' => $this->published_at?->toIso8601String(),
            'publisher' => $this->whenLoaded('user', fn (): array => [
                'id' => $this->user->id,
                'name' => $this->user->name,
            ]),
            'versions' => ListingVersionResource::collection($this->whenLoaded('versions')),
            // The publisher-facing state, and the reason behind it. Withheld from
            // everyone else: "removed for copyright" on a public page is a
            // finding about a person, published before they have answered it.
            'status' => $this->when($privileged, $this->status),
            'open_report_count' => $this->when($privileged, $this->open_report_count),
            'moderation_reason' => $this->when($privileged, $this->moderation_reason),
            'moderated_at' => $this->when($privileged, fn () => $this->moderated_at?->toIso8601String()),
        ];
    }
}
