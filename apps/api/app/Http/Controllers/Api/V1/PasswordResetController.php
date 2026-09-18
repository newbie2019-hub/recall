<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\ForgotPasswordRequest;
use App\Http\Requests\Api\V1\ResetPasswordRequest;
use App\Models\User;
use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Password;

/**
 * Forgotten passwords, on Laravel's own broker.
 *
 * No service of its own: the broker already is the service — it owns the token
 * table, the hashing, the 60-minute expiry and the resend throttle, and wrapping
 * it would only re-spell them.
 */
class PasswordResetController extends Controller
{
    use RespondsWithApi;

    public function send(ForgotPasswordRequest $request): JsonResponse
    {
        // The mail link has to open the **web app**, not the API: `/reset/{token}`
        // is a react-router path (apps/web/src/routes/paths.ts) and Laravel's
        // stock notification would otherwise sign a URL for a `password.reset`
        // web route this application does not have. Set here rather than in a
        // provider because this is the only place that sends the notification.
        ResetPassword::createUrlUsing(fn (User $user, string $token): string => sprintf(
            '%s/reset/%s?email=%s',
            rtrim((string) config('app.frontend_url', 'http://localhost:5173'), '/'),
            $token,
            urlencode($user->getEmailForPasswordReset()),
        ));

        Password::sendResetLink($request->only('email'));

        // One answer for "sent", "no such account" and "asked again too soon".
        // Branching on the broker's status would turn this endpoint into a way
        // to discover which addresses have accounts here — the same reason
        // AuthService::login has a single message for both its failures.
        return $this->ok(['sent' => true]);
    }

    public function reset(ResetPasswordRequest $request): JsonResponse
    {
        $status = Password::reset(
            $request->only('email', 'password', 'token'),
            function (User $user, string $password): void {
                // `password` is cast `hashed` on the model, so this is the hash.
                $user->forceFill(['password' => $password])->save();

                // A reset usually means somebody else had the old password, so
                // every live token dies. The device rows and their cursors stay
                // — that is sign-out, not revoke (PHASES §5), and each device
                // resumes on its next sign-in instead of re-pulling everything.
                $user->devices()->update(['token_id' => null]);
                $user->tokens()->delete();
            },
        );

        if ($status === Password::RESET_THROTTLED) {
            throw new ApiException(ApiErrorCode::RateLimited, __($status));
        }

        // Expired, already used, or minted for a different address. The client
        // shows it on the form and offers a fresh link; it never redirects.
        if ($status !== Password::PASSWORD_RESET) {
            throw new ApiException(
                ApiErrorCode::ValidationFailed,
                'That reset link is no longer valid. Ask for a new one.',
                ['token' => [__($status)]],
            );
        }

        return $this->ok(['reset' => true]);
    }
}
