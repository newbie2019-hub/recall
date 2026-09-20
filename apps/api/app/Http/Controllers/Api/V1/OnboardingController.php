<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Concerns\RespondsWithApi;
use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\OnboardingRequest;
use App\Services\Onboarding\OnboardingService;
use Illuminate\Http\JsonResponse;

/**
 * The welcome wizard's one endpoint.
 *
 * A PUT because it is an upsert keyed on the account, so the three-screen
 * wizard can be reloaded, resumed or submitted twice without leaving a second
 * row. What comes back is only the flag the client actually branches on — the
 * answers are ours, and echoing them would invite a screen that renders them.
 */
class OnboardingController extends Controller
{
    use RespondsWithApi;

    public function __construct(private readonly OnboardingService $onboarding) {}

    public function update(OnboardingRequest $request): JsonResponse
    {
        $this->onboarding->save($request->user(), $request->validated());

        return $this->ok(['onboarded' => true]);
    }
}
