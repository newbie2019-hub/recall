import { useState, type ComponentType } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  ArrowLeft, ArrowRight, Award, BookOpen, Briefcase, CalendarCheck, ClipboardCheck,
  Code, Cog, Compass, CircleEllipsis, FlaskConical, GraduationCap, HeartPulse,
  Instagram, Landmark, Languages, Layers, MessageCircle, Mic, Microscope, PawPrint,
  Pill, Presentation, Scale, School, Search, Smile, Sparkles, Stethoscope, Target,
  TrendingUp, Users, Youtube,
} from 'lucide-react'
import {
  COUNTRIES, DAILY_MINUTES, GOALS, HEARD_FROM, LEVELS, ROLES, STEPS, SUBJECTS,
  countryName, stepComplete,
  type Goal, type HeardFrom, type Level, type OnboardingAnswers, type Role,
  type StepId, type Subject,
} from '@recall/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { paths } from './paths'

/**
 * Six screens between signing up and the deck list, one question each.
 *
 * **Every question here is one we will later group by**, which is why the
 * answers are picked from a list rather than typed, and why the two "something
 * else" options make their free-text box required — "other" on its own is the
 * one answer that tells us nothing.
 *
 * One question per screen is the whole design. A single page carrying eleven
 * fields is a form: people scan it, answer what they feel like, and every
 * optional field comes back blank. Asking one thing at a time costs six taps
 * and is what makes room for the answers to be *tiles* — a labelled target with
 * an icon, readable at a glance and reachable with a thumb — instead of
 * dropdowns that hide their own options until you open them.
 *
 * The step is in the URL, following `SettingsPage`'s pattern, so Back and
 * Forward work and a refresh does not restart the wizard. Answers live in one
 * object and go up in a single `PUT` at the end: six requests would mean six
 * chances to leave half a row behind, and the endpoint is an upsert precisely
 * so the one request can be retried.
 *
 * `daily_minutes` is the only question that gives something back — it becomes
 * the target the stats screen measures against.
 */
export function WelcomePage() {
  const navigate = useNavigate()
  const { refreshUser, client, user } = useAuth()
  const { step: param } = useParams()
  const [answers, setAnswers] = useState<Partial<OnboardingAnswers>>({ goals: [] })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const found = STEPS.findIndex((s) => s.id === param)
  const index = found === -1 ? 0 : found
  const step = STEPS[index]!
  const isLast = index === STEPS.length - 1
  const ready = stepComplete(step.id as StepId, answers)

  const set = <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) =>
    setAnswers((a) => ({ ...a, [key]: value }))

  /** Answering a single-choice question is also the decision to move on. */
  const choose = <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) => {
    set(key, value)
    if (value !== 'other') setTimeout(() => go(index + 1), 160)
  }

  const go = (to: number) => {
    const target = STEPS[Math.min(Math.max(to, 0), STEPS.length - 1)]
    if (target) navigate(paths.welcomeStep(target.id))
  }

  async function next() {
    if (!isLast) return go(index + 1)

    setSaving(true)
    setError(null)
    try {
      await client.saveOnboarding(answers as OnboardingAnswers)
      // The guard reads `onboarded` off the session, so it has to be re-read
      // before navigating or the deck list bounces straight back here.
      await refreshUser()
      navigate(paths.decks, { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 py-10 sm:py-16">
      {/* A row of segments rather than a bar: six steps is few enough to show
          as places, and "two left" reads faster than a percentage. */}
      <div className="flex items-center gap-1.5" aria-hidden>
        {STEPS.map((s, i) => (
          <span
            key={s.id}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors',
              i < index ? 'bg-hematoxylin' : i === index ? 'bg-hematoxylin/60' : 'bg-border',
            )}
          />
        ))}
      </div>
      <p className="mt-3 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
        Step {index + 1} of {STEPS.length}
      </p>

      <div className="flex flex-1 flex-col justify-center py-10 sm:py-14">
        <h1 className="font-display text-4xl tracking-tight sm:text-5xl">{step.title}</h1>
        <p className="mt-3 max-w-prose text-sm text-muted-foreground">{BLURB[step.id]}</p>

        <div className="mt-10 space-y-10">
          {step.id === 'role' && (
            <>
              <Tiles
                options={ROLES}
                icons={ICONS}
                value={answers.role}
                onChange={(v) => choose('role', v as Role)}
              />
              <Optional label="Where you are" id="country" hint="Only shapes what we build next.">
                <Select value={answers.country ?? ''} onValueChange={(v) => set('country', v)}>
                  <SelectTrigger id="country" className="sm:w-72">
                    <SelectValue placeholder="Choose a country" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {COUNTRIES.map((code) => (
                      <SelectItem key={code} value={code}>
                        {countryName(code)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Optional>
            </>
          )}

          {step.id === 'subject' && (
            <>
              <Tiles
                options={SUBJECTS}
                icons={ICONS}
                columns="sm:grid-cols-3"
                value={answers.subject}
                onChange={(v) => choose('subject', v as Subject)}
              />
              {answers.subject === 'other' && (
                <Optional label="Which is" id="subject_other" required>
                  <Input
                    id="subject_other"
                    autoFocus
                    className="sm:w-96"
                    value={answers.subject_other ?? ''}
                    onChange={(e) => set('subject_other', e.target.value)}
                    placeholder="Tell us in a few words"
                  />
                </Optional>
              )}
            </>
          )}

          {step.id === 'level' && (
            <Tiles
              options={LEVELS}
              icons={ICONS}
              value={answers.level}
              onChange={(v) => choose('level', v as Level)}
            />
          )}

          {step.id === 'goals' && (
            <Tiles
              options={GOALS}
              icons={ICONS}
              multi
              value={answers.goals ?? []}
              onChange={(v) =>
                set(
                  'goals',
                  (answers.goals ?? []).includes(v as Goal)
                    ? (answers.goals ?? []).filter((g) => g !== v)
                    : [...(answers.goals ?? []), v as Goal],
                )
              }
            />
          )}

          {step.id === 'time' && (
            <>
              <Tiles
                options={DAILY_MINUTES.map((m) => [String(m), `${m} minutes`] as const)}
                value={answers.daily_minutes ? String(answers.daily_minutes) : undefined}
                columns="sm:grid-cols-4"
                onChange={(v) => set('daily_minutes', Number(v))}
              />
              <Optional
                label="Studying for a date?"
                id="exam_date"
                hint="If there's an exam, we'll keep an eye on the calendar."
              >
                <Input
                  id="exam_date"
                  type="date"
                  className="sm:w-56"
                  value={answers.exam_date ?? ''}
                  onChange={(e) => set('exam_date', e.target.value || null)}
                />
              </Optional>
            </>
          )}

          {step.id === 'source' && (
            <>
              <Tiles
                options={HEARD_FROM}
                icons={ICONS}
                columns="sm:grid-cols-3"
                value={answers.heard_from}
                onChange={(v) => set('heard_from', v as HeardFrom)}
              />
              {answers.heard_from === 'other' && (
                <Optional label="Where was that" id="heard_from_other" required>
                  <Input
                    id="heard_from_other"
                    autoFocus
                    className="sm:w-96"
                    value={answers.heard_from_other ?? ''}
                    onChange={(e) => set('heard_from_other', e.target.value)}
                    placeholder="A poster, a lecturer, a podcast…"
                  />
                </Optional>
              )}
              <Optional label="Referral code" id="referral_code" hint="If somebody gave you one.">
                <Input
                  id="referral_code"
                  className="sm:w-56 uppercase"
                  value={answers.referral_code ?? ''}
                  onChange={(e) => set('referral_code', e.target.value)}
                  autoComplete="off"
                />
              </Optional>
            </>
          )}
        </div>

        {error && <p className="mt-8 font-mono text-xs text-eosin">{error}</p>}
      </div>

      <div className="flex items-center gap-3 border-t border-border pt-6">
        <Button variant="ghost" disabled={index === 0 || saving} onClick={() => go(index - 1)}>
          <ArrowLeft /> Back
        </Button>
        <span className="flex-1" />
        {/* The single-choice steps advance themselves, so this is the way
            forward on the optional step and the way to finish on the last. */}
        <Button size="lg" disabled={!ready || saving} onClick={() => void next()}>
          {saving ? 'Saving…' : isLast ? `Start studying${first(user?.name)}` : 'Continue'}
          {!saving && !isLast && <ArrowRight />}
        </Button>
      </div>
    </main>
  )
}

/** A blurb per step: what the answer is for, in one line, honestly. */
const BLURB: Record<(typeof STEPS)[number]['id'], string> = {
  role: 'A few quick questions so the app knows what it is helping with. Six taps, then your cards.',
  subject: 'It decides which shared decks we put in front of you first.',
  level: 'Nothing is locked behind this — it tells us who we are building for.',
  goals: 'Pick as many as fit.',
  time: 'Optional, and it comes back to you: whatever you pick becomes the daily target on your stats screen.',
  source: 'The one answer that decides where we spend our time next.',
}

const first = (name?: string) => (name ? `, ${name.split(' ')[0]}` : '')

/**
 * The answers, as targets rather than a list you have to open.
 *
 * A dropdown hides every option until it is opened and then shows them as a
 * column of text; a grid of tiles shows all of them at once, gives each a
 * distinct shape to recognise, and is reachable with a thumb. The icon is
 * decoration in the literal sense — the label carries the meaning and the icon
 * only helps you find the one you already read, which is why they are
 * `aria-hidden` and why nothing here is distinguished by icon alone.
 */
function Tiles({
  options, icons, value, onChange, multi, columns = 'sm:grid-cols-2',
}: {
  options: ReadonlyArray<readonly [string, string]>
  icons?: Record<string, ComponentType<{ className?: string }>>
  value: string | string[] | undefined
  onChange: (value: string) => void
  multi?: boolean
  columns?: string
}) {
  const selected = (v: string) => (Array.isArray(value) ? value.includes(v) : value === v)

  return (
    <div role={multi ? 'group' : 'radiogroup'} className={cn('grid grid-cols-1 gap-3', columns)}>
      {options.map(([v, label]) => {
        const Icon = icons?.[v]
        const on = selected(v)
        return (
          <button
            key={v}
            type="button"
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={on}
            onClick={() => onChange(v)}
            className={cn(
              'flex items-center gap-3 rounded-md border px-4 py-3.5 text-left text-sm transition-colors',
              'hover:border-hematoxylin/60 hover:bg-accent',
              on
                ? 'border-hematoxylin bg-hematoxylin/10 font-medium text-foreground'
                : 'border-border text-muted-foreground',
            )}
          >
            {Icon && (
              <Icon
                className={cn('size-4 shrink-0', on ? 'text-hematoxylin' : 'text-muted-foreground')}
              />
            )}
            <span className="min-w-0 flex-1">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** A secondary field under the tiles, visibly a smaller ask than the question. */
const Optional = ({
  label, id, hint, required, children,
}: { label: string; id: string; hint?: string; required?: boolean; children: React.ReactNode }) => (
  <div className="grid gap-2 border-t border-border pt-8">
    <Label htmlFor={id} className="text-sm">
      {label}
      {!required && <span className="ml-2 text-xs font-normal text-muted-foreground">optional</span>}
    </Label>
    {children}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
)

/**
 * One icon per answer.
 *
 * Kept here rather than in `packages/core` because core is shared with a React
 * Native build that will not have lucide, and an icon is a rendering decision
 * about a value — not part of the value itself.
 */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  // Roles
  student: GraduationCap,
  professional: Briefcase,
  teacher: Presentation,
  self_learner: Compass,
  // Levels
  high_school: School,
  undergraduate: GraduationCap,
  postgraduate: Microscope,
  self_taught: BookOpen,
  // Subjects
  medicine: Stethoscope,
  nursing: HeartPulse,
  pharmacy: Pill,
  dentistry: Smile,
  veterinary: PawPrint,
  law: Scale,
  languages: Languages,
  computer_science: Code,
  engineering: Cog,
  business: TrendingUp,
  humanities: Landmark,
  sciences: FlaskConical,
  test_prep: ClipboardCheck,
  // Goals
  pass_exam: Target,
  coursework: CalendarCheck,
  certification: Award,
  language: Languages,
  career: Briefcase,
  curiosity: Sparkles,
  // Where they found us
  reddit: MessageCircle,
  youtube: Youtube,
  tiktok: Mic,
  instagram: Instagram,
  friend: Users,
  search: Search,
  anki_community: Layers,
  university: School,
  podcast: Mic,
  // Shared by "something else" everywhere it appears.
  other: CircleEllipsis,
}
