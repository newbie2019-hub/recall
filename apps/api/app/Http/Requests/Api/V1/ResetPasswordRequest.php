<?php

namespace App\Http\Requests\Api\V1;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rules\Password;

class ResetPasswordRequest extends FormRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            // Both arrive from the link: the token in the path, the address in
            // its query string. The broker needs the pair — a token alone says
            // nothing about whose account it unlocks.
            'token' => ['required', 'string'],
            'email' => ['required', 'string', 'email'],
            // Same policy object sign-up uses (AppServiceProvider), so a
            // password accepted at registration cannot be refused at reset.
            'password' => ['required', 'string', Password::defaults()],
        ];
    }
}
