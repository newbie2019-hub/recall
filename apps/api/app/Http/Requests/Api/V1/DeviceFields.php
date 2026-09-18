<?php

namespace App\Http\Requests\Api\V1;

/**
 * The device identity every sign-in carries.
 *
 * Shared by register and login because they are the same three fields, and a
 * copy that drifts would mean one path names the device and the other does not
 * — leaving a row on the account screen called "Unknown".
 *
 * `device_id` is optional and client-generated: a device that has signed in
 * before sends the id it was given, and keeps its sync cursor instead of
 * re-pulling the whole collection.
 */
final class DeviceFields
{
    /**
     * @return array<string, mixed>
     */
    public static function rules(): array
    {
        return [
            'device_name' => ['required', 'string', 'max:255'],
            'device_id' => ['nullable', 'uuid'],
            'platform' => ['nullable', 'string', 'max:32'],
        ];
    }
}
