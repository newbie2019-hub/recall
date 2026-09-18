<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\DeleteAccountRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

class AccountController extends Controller
{
    use RespondsWithApi;

    /**
     * Delete the account and everything the server holds for it.
     *
     * Every syncable table hangs off `user_id` with `cascadeOnDelete`, so the
     * row going is the collection going. The transaction is what stops a
     * half-deleted account existing: an account whose decks are gone but whose
     * tokens still work is worse than one that is still there.
     *
     * What this does *not* touch is the copy on each device. Local rows are the
     * person's, deleting the account is deleting the server's copy, and
     * whether a device also erases itself is a separate choice made on that
     * device (PHASES §5 — deletion offers an .apkg export first).
     */
    public function destroy(DeleteAccountRequest $request): JsonResponse
    {
        $user = $request->user();

        if (! Hash::check($request->string('password')->toString(), $user->password)) {
            throw new ApiException(
                ApiErrorCode::InvalidCredentials,
                'That password does not match this account.',
            );
        }

        DB::transaction(static function () use ($user): void {
            // Sanctum's tokenable is polymorphic, so no foreign key reaches it
            // and `cascadeOnDelete` cannot clean these up. Left alone they are
            // orphaned credential rows that outlive the account they belonged
            // to — they stop authenticating anything, because the user they
            // resolve to is gone, but a credential table that keeps rows for
            // deleted accounts is not something to leave behind on purpose.
            $user->tokens()->delete();
            $user->delete();
        });

        return $this->ok(['deleted' => true]);
    }
}
