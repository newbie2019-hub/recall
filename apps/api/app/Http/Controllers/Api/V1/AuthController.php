<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\LoginRequest;
use App\Http\Requests\Api\V1\RegisterRequest;
use App\Http\Resources\DeviceResource;
use App\Http\Resources\UserResource;
use App\Models\Device;
use App\Models\User;
use App\Services\Auth\AuthService;
use App\Services\Auth\DeviceIdentity;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Laravel\Sanctum\NewAccessToken;

class AuthController extends Controller
{
    use RespondsWithApi;

    public function __construct(private readonly AuthService $auth) {}

    public function register(RegisterRequest $request): JsonResponse
    {
        $session = $this->auth->register(
            $request->string('name')->toString(),
            $request->string('email')->toString(),
            $request->string('password')->toString(),
            DeviceIdentity::fromRequest($request),
        );

        return $this->created($this->present($request, $session));
    }

    public function login(LoginRequest $request): JsonResponse
    {
        $session = $this->auth->login(
            $request->string('email')->toString(),
            $request->string('password')->toString(),
            DeviceIdentity::fromRequest($request),
        );

        return $this->ok($this->present($request, $session));
    }

    public function logout(Request $request): JsonResponse
    {
        $this->auth->logout($request->user(), $request->user()->currentAccessToken()->id);

        return $this->ok(['signed_out' => true]);
    }

    public function me(Request $request): JsonResponse
    {
        return $this->ok(new UserResource($request->user()));
    }

    /**
     * @param  array{user: User, token: NewAccessToken, device: Device}  $session
     * @return array<string, mixed>
     */
    private function present(Request $request, array $session): array
    {
        // The resources ask the request who is signed in, and during register
        // and login nobody is yet.
        $request->setUserResolver(fn () => $session['user']);

        return [
            'user' => new UserResource($session['user']),
            'device' => new DeviceResource($session['device']),
            'token' => $session['token']->plainTextToken,
            'expires_at' => $session['token']->accessToken->expires_at?->toIso8601String(),
        ];
    }
}
