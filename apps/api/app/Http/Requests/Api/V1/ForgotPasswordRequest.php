<?php

namespace App\Http\Requests\Api\V1;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Deliberately does not check that the address exists. The controller answers
 * the same way either way — a 422 "no such account" here would hand anyone a
 * way to ask which addresses have accounts on this server.
 */
class ForgotPasswordRequest extends FormRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'email' => ['required', 'string', 'email', 'max:255'],
        ];
    }
}
