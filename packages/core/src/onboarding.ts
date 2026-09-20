/**
 * What we ask a new account, and the only place the answers are enumerated.
 *
 * These lists are hand-mirrored in `app/Services/Onboarding/OnboardingService.php`,
 * the same way `api/types.ts` mirrors the error enum rather than generating it.
 * The rule is the one that already governs that file: **the server validates
 * against its own copy.** A client sending an unknown value is rejected, so the
 * two drifting costs a 422, never a bad row.
 *
 * Every value is a stable snake_case key, never the label. Labels are prose and
 * will be rewritten; keys end up in a `GROUP BY` and must not.
 */

export interface OnboardingAnswers {
  role: Role
  country: string | null
  subject: Subject
  subject_other: string | null
  level: Level
  goals: Goal[]
  daily_minutes: number | null
  exam_date: string | null
  heard_from: HeardFrom
  heard_from_other: string | null
  referral_code: string | null
}

export const ROLES = [
  ['student', 'Student'],
  ['professional', 'Working professional'],
  ['teacher', 'Teacher or tutor'],
  ['self_learner', 'Learning on my own'],
  ['other', 'Something else'],
] as const satisfies ReadonlyArray<readonly [string, string]>

export const LEVELS = [
  ['high_school', 'High school'],
  ['undergraduate', 'Undergraduate'],
  ['postgraduate', 'Postgraduate'],
  ['professional', 'Professional training'],
  ['self_taught', 'Self-taught'],
] as const satisfies ReadonlyArray<readonly [string, string]>

export const SUBJECTS = [
  ['medicine', 'Medicine'],
  ['nursing', 'Nursing'],
  ['pharmacy', 'Pharmacy'],
  ['dentistry', 'Dentistry'],
  ['veterinary', 'Veterinary'],
  ['law', 'Law'],
  ['languages', 'Languages'],
  ['computer_science', 'Computer science'],
  ['engineering', 'Engineering'],
  ['business', 'Business or finance'],
  ['humanities', 'Humanities'],
  ['sciences', 'Natural sciences'],
  ['test_prep', 'Test preparation'],
  ['other', 'Something else'],
] as const satisfies ReadonlyArray<readonly [string, string]>

export const GOALS = [
  ['pass_exam', 'Pass a specific exam'],
  ['coursework', 'Keep up with coursework'],
  ['certification', 'Earn a professional certification'],
  ['language', 'Learn a language'],
  ['career', 'Get better at my job'],
  ['curiosity', 'Remember things I care about'],
] as const satisfies ReadonlyArray<readonly [string, string]>

export const HEARD_FROM = [
  ['reddit', 'Reddit'],
  ['youtube', 'YouTube'],
  ['tiktok', 'TikTok'],
  ['instagram', 'Instagram'],
  ['friend', 'A friend or classmate'],
  ['search', 'A web search'],
  ['anki_community', 'The Anki community'],
  ['university', 'My school or university'],
  ['podcast', 'A podcast or newsletter'],
  ['other', 'Somewhere else'],
] as const satisfies ReadonlyArray<readonly [string, string]>

/**
 * Minutes a day. Offered rather than typed, because the answer is a *plan* and
 * a text field invites "60" from someone who will do fifteen.
 *
 * This one is not only a survey answer: it becomes the target the dashboard
 * measures against (PLAN §7). Every other question here takes something from
 * the person; this one gives something back.
 */
export const DAILY_MINUTES = [10, 15, 20, 30, 45, 60, 90] as const

export type Role = (typeof ROLES)[number][0]
export type Level = (typeof LEVELS)[number][0]
export type Subject = (typeof SUBJECTS)[number][0]
export type Goal = (typeof GOALS)[number][0]
export type HeardFrom = (typeof HEARD_FROM)[number][0]

/** `other` on these two fields makes its free-text sibling required. */
export const NEEDS_OTHER = 'other'

/**
 * ISO-3166-1 alpha-2, labelled at runtime by `Intl.DisplayNames`.
 *
 * Codes rather than names, because a name is a translation and a code is an
 * identity — and because shipping 250 English labels would mean shipping them
 * again for every language the app is later read in. The browser already has
 * them all.
 */
export const COUNTRIES =
  ('AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ ' +
    'CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI ' +
    'FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM ' +
    'JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG ' +
    'MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK ' +
    'PL PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD ' +
    'TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW')
    .split(' ')

/**
 * The country name in the reader's own language, or the bare code.
 *
 * `Intl.DisplayNames.of()` throws a `RangeError` on anything that is not a
 * well-formed region — which a code stored by an older build could be — so the
 * catch is load-bearing rather than defensive habit.
 */
export function countryName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames([locale ?? 'en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * The wizard, one question per screen.
 *
 * Kept as data rather than as a validation schema per step so the wizard, the
 * progress bar and the test all read the same source.
 *
 * **One question per step is the design, not an accident.** Three screens each
 * carrying four fields is a form with a progress bar on it — people scan it,
 * answer the ones they feel like, and the optional fields go blank. Asking one
 * thing at a time costs six taps and gets six answers, and it is what lets
 * every choice be a labelled button rather than a dropdown.
 *
 * Optional by design: `country`, `daily_minutes`, `exam_date`, `referral_code`.
 */
export const STEPS = [
  { id: 'role', title: 'What brings you here?', required: ['role'] },
  { id: 'subject', title: 'What are you studying?', required: ['subject'] },
  { id: 'level', title: 'How far along are you?', required: ['level'] },
  { id: 'goals', title: 'What are you after?', required: ['goals'] },
  { id: 'time', title: 'How much time have you got?', required: [] },
  { id: 'source', title: 'How did you find us?', required: ['heard_from'] },
] as const satisfies ReadonlyArray<{
  id: string
  title: string
  required: ReadonlyArray<keyof OnboardingAnswers>
}>

export type StepId = (typeof STEPS)[number]['id']

/**
 * Whether a step is answered well enough to move on.
 *
 * The `other` rule is the only non-obvious part: choosing "Something else"
 * turns its free-text sibling into a required field, because "other" on its own
 * is the one answer that tells us nothing at all.
 */
export function stepComplete(step: StepId, answers: Partial<OnboardingAnswers>): boolean {
  const spec = STEPS.find((s) => s.id === step)
  if (!spec) return false

  for (const field of spec.required) {
    const value = answers[field]
    if (value === undefined || value === null) return false
    if (Array.isArray(value) ? value.length === 0 : String(value).trim() === '') return false
  }

  if (step === 'subject' && answers.subject === NEEDS_OTHER && !answers.subject_other?.trim()) return false
  if (step === 'source' && answers.heard_from === NEEDS_OTHER && !answers.heard_from_other?.trim()) return false

  return true
}
