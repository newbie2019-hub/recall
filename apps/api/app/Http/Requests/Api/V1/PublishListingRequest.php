<?php

declare(strict_types=1);

namespace App\Http\Requests\Api\V1;

use App\Models\Listing;
use App\Models\ListingVersion;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Publish a deck, or cut the next version of one already published.
 *
 * `rights_attestation` is required and has no default: PHASES §8 wants the claim
 * recorded with the version, and a claim nobody had to make is not a claim.
 */
class PublishListingRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()?->can('publish', Listing::class) ?? false;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'deck_id' => ['required', 'uuid'],
            'title' => ['required', 'string', 'max:120'],
            'description' => ['nullable', 'string', 'max:4000'],
            'tags' => ['sometimes', 'array', 'max:10'],
            'tags.*' => ['string', 'max:40'],
            'visibility' => ['sometimes', Rule::in(Listing::VISIBILITIES)],
            // Display only. The integer `version` is the identity, because
            // `decks.source_version` on the client is an INTEGER column.
            'semver' => ['nullable', 'string', 'max:32'],
            'changelog' => ['nullable', 'string', 'max:4000'],
            'rights_attestation' => ['required', Rule::in(ListingVersion::RIGHTS)],
        ];
    }

    /**
     * @return array{deck_id: string, title: string, description: ?string, tags: list<string>, visibility: string, semver: ?string, changelog: ?string, rights_attestation: string}
     */
    public function listing(): array
    {
        return [
            'deck_id' => $this->string('deck_id')->toString(),
            'title' => $this->string('title')->toString(),
            'description' => $this->input('description'),
            'tags' => array_values($this->input('tags', [])),
            'visibility' => $this->input('visibility', Listing::VISIBILITY_UNLISTED),
            'semver' => $this->input('semver'),
            'changelog' => $this->input('changelog'),
            'rights_attestation' => $this->string('rights_attestation')->toString(),
        ];
    }
}
