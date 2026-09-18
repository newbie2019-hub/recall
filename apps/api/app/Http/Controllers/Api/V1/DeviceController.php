<?php

namespace App\Http\Controllers\Api\V1;

use App\Contracts\Repositories\DeviceRepository;
use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Resources\DeviceResource;
use App\Services\Auth\AuthService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The account screen's device list. Revoking one signs out exactly that phone.
 */
class DeviceController extends Controller
{
    use RespondsWithApi;

    public function __construct(
        private readonly AuthService $auth,
        private readonly DeviceRepository $devices,
    ) {}

    public function index(Request $request): JsonResponse
    {
        return $this->ok(DeviceResource::collection($this->devices->listForUser($request->user())));
    }

    public function destroy(Request $request, string $device): JsonResponse
    {
        $this->auth->revokeDevice($request->user(), $device);

        return $this->ok(['revoked' => true]);
    }
}
