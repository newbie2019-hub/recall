<?php

namespace App\Services\Auth;

use Illuminate\Http\Request;

/**
 * Who is asking, as a value object rather than three loose strings.
 *
 * Register and login both carry the same three fields, and passing them
 * positionally is how "name" and "platform" eventually end up swapped in one of
 * the two call sites and nowhere else.
 */
final readonly class DeviceIdentity
{
    public function __construct(
        public string $name,
        public ?string $id = null,
        public ?string $platform = null,
    ) {}

    public static function fromRequest(Request $request): self
    {
        return new self(
            name: $request->string('device_name')->toString(),
            id: $request->input('device_id'),
            platform: $request->input('platform'),
        );
    }
}
