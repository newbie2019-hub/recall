<?php

declare(strict_types=1);

namespace App\Http\Requests\Api\V1;

use App\Services\Onboarding\OnboardingService;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * The welcome wizard's payload.
 *
 * A FormRequest rather than an inline `$request->validate()` because this body
 * is eleven fields with two conditional ones — the threshold the rest of the
 * API already uses (register, publish, report get one; a two-field rating does
 * not).
 *
 * The allowed values come from {@see OnboardingService} so there is exactly one
 * copy per side of the wire.
 */
class OnboardingRequest extends FormRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'role' => ['required', Rule::in(OnboardingService::ROLES)],
            // ISO-3166 alpha-2. Optional: plenty of people will not say, and a
            // required country is a question that gets answered with a lie.
            'country' => ['nullable', 'string', 'size:2', 'alpha'],
            'subject' => ['required', Rule::in(OnboardingService::SUBJECTS)],
            'level' => ['required', Rule::in(OnboardingService::LEVELS)],
            'goals' => ['required', 'array', 'min:1'],
            'goals.*' => [Rule::in(OnboardingService::GOALS)],
            'daily_minutes' => ['nullable', 'integer', 'min:1', 'max:1440'],
            'exam_date' => ['nullable', 'date'],
            'heard_from' => ['required', Rule::in(OnboardingService::HEARD_FROM)],
            'referral_code' => ['nullable', 'string', 'max:64'],

            // "Other" on its own is the one answer that tells us nothing, so
            // choosing it makes its free-text sibling required.
            'subject_other' => [
                Rule::requiredIf(fn (): bool => $this->input('subject') === 'other'),
                'nullable', 'string', 'max:120',
            ],
            'heard_from_other' => [
                Rule::requiredIf(fn (): bool => $this->input('heard_from') === 'other'),
                'nullable', 'string', 'max:120',
            ],
        ];
    }
}
