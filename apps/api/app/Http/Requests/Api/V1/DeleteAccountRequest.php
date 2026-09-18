<?php

namespace App\Http\Requests\Api\V1;

use Illuminate\Foundation\Http\FormRequest;

class DeleteAccountRequest extends FormRequest
{
    /**
     * The password again, not just the bearer token.
     *
     * A live token is enough to study with. It is not enough to end an account
     * with, because the person holding the device may not be the person who
     * left the session open on it.
     *
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'password' => ['required', 'string'],
        ];
    }
}
