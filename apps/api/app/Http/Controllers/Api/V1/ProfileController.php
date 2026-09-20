<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Resources\UserResource;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password;

/**
 * The three things somebody can change about their own account.
 *
 * Kept out of `AuthController`, which is about *sessions* — signing in, signing
 * out, and what the token currently proves. This is about the account behind
 * one, and the two have different throttles for good reason.
 *
 * Small bodies, so validation is inline. That is the existing convention: the
 * marketplace validates a two-field rating in its controller and reserves a
 * FormRequest for a payload with rules worth naming.
 */
class ProfileController extends Controller
{
    use RespondsWithApi;

    /**
     * Name, address and avatar.
     *
     * **Changing the address un-verifies it**, because the old proof was proof
     * about a different mailbox. Anything gated on verification — publishing to
     * the marketplace, most obviously — correctly closes until the new address
     * is confirmed, and that is the honest behaviour rather than an oversight.
     */
    public function update(Request $request): JsonResponse
    {
        $user = $request->user();

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:255'],
            'email' => ['sometimes', 'string', 'email', 'max:255', Rule::unique('users')->ignore($user->id)],
            // A key from the client's own set. Unknown keys fall back to
            // initials there, so the only thing to enforce here is a shape that
            // cannot carry a URL or markup.
            'avatar' => ['sometimes', 'nullable', 'string', 'max:32', 'regex:/^[a-z0-9_-]+$/'],
        ]);

        if (isset($data['email']) && $data['email'] !== $user->email) {
            $user->email_verified_at = null;
        }

        $user->fill($data)->save();

        return $this->ok(new UserResource($user->fresh()));
    }

    /**
     * Change the password, proving the old one first.
     *
     * The current password is required even though the bearer token already
     * authenticates the request: a token is something a borrowed laptop has,
     * and a password change is the one action that would lock its owner out of
     * their own account.
     *
     * Other devices keep their tokens on purpose. Signing every phone out
     * because somebody tidied their password is a punishment for good hygiene,
     * and the devices screen is right there for when it is actually wanted.
     */
    public function password(Request $request): JsonResponse
    {
        $user = $request->user();

        $data = $request->validate([
            'current_password' => ['required', 'string'],
            'password' => ['required', 'string', 'confirmed', Password::defaults()],
        ]);

        if (! Hash::check($data['current_password'], $user->password)) {
            throw new ApiException(ApiErrorCode::InvalidCredentials, 'That is not your current password.');
        }

        $user->forceFill(['password' => $data['password']])->save();

        return $this->ok(['changed' => true]);
    }
}
