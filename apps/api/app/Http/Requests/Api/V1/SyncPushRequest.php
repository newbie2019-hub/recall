<?php

namespace App\Http\Requests\Api\V1;

use App\Enums\SyncResource;
use Illuminate\Foundation\Http\FormRequest;

/**
 * A push carries whatever the device has been holding, grouped by resource.
 *
 * Validated shallowly on purpose: the columns each resource accepts are already
 * declared once in `SyncResource::writable()`, and re-listing them here as
 * validation rules would be the same list in two places, drifting. What this
 * enforces is the shape — known resource names, arrays of objects, a key on
 * every row, and a page size the server is willing to hold in memory.
 */
class SyncPushRequest extends FormRequest
{
    public const MAX_ROWS_PER_RESOURCE = 1_000;

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        $rules = [];

        foreach (SyncResource::all() as $resource) {
            $key = $resource->value;
            $rules[$key] = ['sometimes', 'array', 'max:'.self::MAX_ROWS_PER_RESOURCE];
            $rules[$key.'.*'] = ['array'];
            $rules[$key.'.*.'.$resource->key()] = ['required', 'string', 'max:80'];

            if ($resource->isAppendOnly()) {
                $rules[$key.'.*.card_id'] = ['required', 'string', 'max:80'];
                $rules[$key.'.*.rating'] = ['required', 'integer', 'between:1,4'];
                $rules[$key.'.*.client_ts'] = ['required', 'integer'];
            } else {
                $rules[$key.'.*.client_updated_at'] = ['required', 'integer'];
            }
        }

        return $rules;
    }

    /**
     * @return array<string, list<array<string, mixed>>>
     */
    public function payload(): array
    {
        return array_filter(
            $this->only(array_map(fn (SyncResource $r) => $r->value, SyncResource::all())),
            fn (mixed $rows) => is_array($rows) && $rows !== [],
        );
    }
}
