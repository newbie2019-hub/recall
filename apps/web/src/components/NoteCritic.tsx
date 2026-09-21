import { useEffect, useState } from 'react'
import { Check, Loader2, Sparkles, Stethoscope } from 'lucide-react'
import { escapeHtml, type AiRewrite, type AiVerdict } from '@recall/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { DIMENSION, TIER } from '@/lib/verdict'

/**
 * The grader, at the moment the card is written.
 *
 * `DoctorPage` points the same rubric at cards that already exist, which is the
 * right shape for a sweep and the wrong shape for prevention: by the time a
 * card reaches that screen it has been reviewed for months, and `reviews` is
 * append-only, so its history is permanent even after the prompt is fixed. The
 * cheapest place to catch a bad card is before it has one.
 *
 * Three rules it inherits from the rest of the AI phase:
 *
 * **It never checks without being asked.** A grade is a real charge against a
 * $0.25 monthly allowance, and a critic that fired on every keystroke would
 * spend the month on the first note. The result is cached against the fields it
 * was asked about, so pressing the button twice on unchanged text is free.
 *
 * **It proposes and never applies.** Each suggested field gets its own button.
 * That is the same rule generated cards follow — 36% of frontier-model cards
 * are unusable and the unusable ones look fine (AI.md §1) — applied to an edit
 * rather than to an insert.
 *
 * **It inserts text, not markup.** Fields are stored as HTML and the
 * suggestion is plain prose, so it is escaped on the way in. README rule 5
 * gives card HTML a script-less iframe *because* it is untrusted; model-authored
 * HTML is untrusted twice.
 */
export function NoteCritic({
  fields, noteType, onApply,
}: {
  fields: Record<string, string>
  noteType: string
  /** Called with HTML, already escaped — the field's stored form. */
  onApply: (name: string, html: string) => void
}) {
  const { user, status, client } = useAuth()
  const [verdict, setVerdict] = useState<AiVerdict | null>(null)
  const [rewrite, setRewrite] = useState<AiRewrite | null>(null)
  const [busy, setBusy] = useState<'check' | 'rewrite' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [taken, setTaken] = useState<Set<string>>(new Set())

  const key = fingerprint(fields)

  // A verdict is about the card it was asked about. Editing a field makes it
  // stale, and a stale badge saying "weak" next to a prompt somebody has since
  // rewritten is worse than no badge at all.
  useEffect(() => {
    setVerdict(null)
    setRewrite(null)
    setTaken(new Set())
    setError(null)
  }, [key])

  // The allowance is counted per account, and there is nothing to send from a
  // signed-out device anyway.
  if (!user) return null

  const offline = status === 'paused'
  const empty = Object.values(fields).every((v) => !v.trim())

  async function run(what: 'check' | 'rewrite') {
    setBusy(what)
    setError(null)
    try {
      if (what === 'check') {
        // One card in a batch built for twenty. The rubric costs more tokens
        // than the card does, so this is the expensive way to grade — which is
        // exactly why it is a button and the sweep is a sweep.
        const { verdicts } = await client.aiGrade([{ id: 'draft', fields: trim(fields) }])
        setVerdict(verdicts[0] ?? null)
      } else {
        setRewrite(await client.aiRewrite({
          fields: trim(fields),
          note_type: noteType,
          // The grader's own words, when there are some. A rewrite aimed at a
          // named flaw beats a general polish.
          flaw: verdict?.reason || (verdict ? DIMENSION[verdict.dimension] ?? '' : ''),
        }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // A rewrite is plain text. Replacing a field that holds an image or a sound
  // with prose would delete the media silently, and a suggestion that costs
  // somebody their recording is not a suggestion.
  const suggestions = Object.entries(rewrite?.fields ?? {})
    .filter(([name]) => !hasMedia(fields[name] ?? ''))
  const withheld = Object.keys(rewrite?.fields ?? {}).length - suggestions.length

  return (
    <section className="mt-6 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button" variant="ghost" size="sm" className="text-muted-foreground"
          disabled={!!busy || offline || empty}
          onClick={() => void run('check')}
          title={offline ? 'This one needs the network. Everything else here does not.' : undefined}
        >
          {busy === 'check' ? <Loader2 className="animate-spin" /> : <Stethoscope />}
          {verdict ? 'Check again' : 'Is this a good card?'}
        </Button>

        <Button
          type="button" variant="ghost" size="sm" className="text-muted-foreground"
          disabled={!!busy || offline || empty}
          onClick={() => void run('rewrite')}
        >
          {busy === 'rewrite' ? <Loader2 className="animate-spin" /> : <Sparkles />}
          Suggest a rewrite
        </Button>

        {offline && (
          <span className="font-mono text-[0.625rem] text-muted-foreground">
            offline — these two need the network
          </span>
        )}
      </div>

      {error && <p className="mt-2 font-mono text-xs text-eosin">{error}</p>}

      {verdict && (
        <div className="mt-3 flex items-start gap-2">
          <Badge variant="outline" className={TIER[verdict.tier]?.className}>
            {TIER[verdict.tier]?.label ?? 'weak'}
          </Badge>
          <p className="max-w-prose text-sm text-muted-foreground">
            {verdict.reason || DIMENSION[verdict.dimension] || 'This prompt holds up.'}
          </p>
        </div>
      )}

      {rewrite && (
        <div className="mt-4 space-y-3">
          {rewrite.note && (
            <p className="max-w-prose text-sm text-muted-foreground">{rewrite.note}</p>
          )}

          {suggestions.map(([name, text]) => (
            <div key={name} className="space-y-1.5 border-l-2 border-hematoxylin/40 pl-3">
              <p className="text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase">
                {name}
              </p>
              <p className="font-body text-sm">{text}</p>
              <Button
                type="button" variant="outline" size="sm"
                disabled={taken.has(name)}
                onClick={() => {
                  // Escaped, because the field is stored as HTML and this is
                  // prose. Nothing the model wrote becomes markup.
                  onApply(name, escapeHtml(text))
                  setTaken((prev) => new Set(prev).add(name))
                }}
              >
                {taken.has(name) ? <><Check /> Used</> : 'Use this'}
              </Button>
            </div>
          ))}

          {withheld > 0 && (
            <p className="text-xs text-muted-foreground">
              {withheld} {withheld === 1 ? 'suggestion holds' : 'suggestions hold'} an image or a
              recording, so {withheld === 1 ? 'it is' : 'they are'} not offered — a plain-text
              rewrite would delete the media.
            </p>
          )}

          {!suggestions.length && !withheld && !rewrite.note && (
            <p className="text-sm text-muted-foreground">Nothing worth changing.</p>
          )}
        </div>
      )}
    </section>
  )
}

/** Media a plain-text rewrite would silently destroy. */
const hasMedia = (html: string) => /<img|\[sound:/i.test(html)

/** What the verdict was about, so an edit invalidates it. */
const fingerprint = (fields: Record<string, string>) =>
  Object.keys(fields).sort().map((k) => `${k}=${fields[k] ?? ''}`).join('\u0000')

/**
 * Twelve fields is the server's ceiling on all three AI endpoints, and a note
 * type with more than that is a spreadsheet. Empty fields are dropped: they
 * cost tokens and say nothing.
 */
const trim = (fields: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim()).slice(0, 12))
