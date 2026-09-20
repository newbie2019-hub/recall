<?php

declare(strict_types=1);

namespace App\Services\Onboarding;

use App\Models\User;
use App\Models\UserProfile;

/**
 * The welcome wizard's answers, and the lists they are checked against.
 *
 * **The lists live here, not in the FormRequest**, for the reason the
 * marketplace already states out loud: a controller is where rules go to be
 * forgotten. These are also the values a marketing question will later
 * `GROUP BY`, which makes them a schema in everything but name — one unvalidated
 * write and a column becomes free text forever.
 *
 * They are hand-mirrored from `packages/core/src/onboarding.ts`, the same
 * convention `api/types.ts` follows for the error enum. The server validates
 * against *its* copy, so the two drifting costs a 422 and never a bad row.
 */
final readonly class OnboardingService
{
    public const ROLES = ['student', 'professional', 'teacher', 'self_learner', 'other'];

    public const LEVELS = ['high_school', 'undergraduate', 'postgraduate', 'professional', 'self_taught'];

    public const SUBJECTS = [
        'medicine', 'nursing', 'pharmacy', 'dentistry', 'veterinary', 'law',
        'languages', 'computer_science', 'engineering', 'business', 'humanities',
        'sciences', 'test_prep', 'other',
    ];

    public const GOALS = ['pass_exam', 'coursework', 'certification', 'language', 'career', 'curiosity'];

    public const HEARD_FROM = [
        'reddit', 'youtube', 'tiktok', 'instagram', 'friend', 'search',
        'anki_community', 'university', 'podcast', 'other',
    ];

    /**
     * Store the answers and mark the wizard finished.
     *
     * `updateOrCreate` on `user_id`, which the unique index backs: the wizard
     * is three screens and a refresh on the last one must not leave two rows
     * behind. `completed_at` is set here rather than by the client, because it
     * is the one field the product branches on and a client may not decide it.
     *
     * @param  array<string, mixed>  $input
     */
    public function save(User $user, array $input): UserProfile
    {
        return UserProfile::query()->updateOrCreate(
            ['user_id' => $user->id],
            [
                'role' => $input['role'],
                'country' => $input['country'] ?? null,
                'subject' => $input['subject'],
                'subject_other' => $this->other($input, 'subject'),
                'level' => $input['level'],
                'goals' => array_values(array_unique($input['goals'])),
                'daily_minutes' => $input['daily_minutes'] ?? null,
                'exam_date' => $input['exam_date'] ?? null,
                'heard_from' => $input['heard_from'],
                'heard_from_other' => $this->other($input, 'heard_from'),
                'referral_code' => $this->referral($input['referral_code'] ?? null),
                'completed_at' => now(),
            ],
        );
    }

    public function completed(User $user): bool
    {
        return UserProfile::query()
            ->where('user_id', $user->id)
            ->whereNotNull('completed_at')
            ->exists();
    }

    /**
     * Free text is kept only when its choice was actually "other".
     *
     * Someone who types into the box, changes their mind and picks Medicine
     * would otherwise leave a stray sentence attached to a clean category, and
     * the first person to read the export would take it for a correction.
     *
     * @param  array<string, mixed>  $input
     */
    private function other(array $input, string $field): ?string
    {
        if (($input[$field] ?? null) !== 'other') {
            return null;
        }

        $value = trim((string) ($input[$field.'_other'] ?? ''));

        return $value === '' ? null : $value;
    }

    /** Case and spacing are how a shared code arrives; they are not part of it. */
    private function referral(?string $code): ?string
    {
        $code = strtoupper(trim((string) $code));

        return $code === '' ? null : $code;
    }
}
