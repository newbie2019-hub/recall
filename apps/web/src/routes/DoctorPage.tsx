import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ArrowLeft, Pencil, Square, Stethoscope } from 'lucide-react'
import { GRADE_BATCH } from '@recall/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { collectionReady } from '@/db/boot'
import * as doctor from '@/db/queries/doctor'
import { useDecks } from '@/hooks/useDecks'
import { useAuth } from '@/lib/auth'
import { DIMENSION, TIER } from '@/lib/verdict'
import { paths } from './paths'

/**
 * The card doctor: the grader pointed at cards you already have.
 *
 * This is the most distinctive thing in the phase and it costs almost nothing
 * beyond the grader itself. Everyone generates flashcards; nobody audits them.
 * It is also what makes a twenty-thousand-card Anki import *better* rather than
 * merely imported — which is the answer to the failure mode this whole project
 * was warned about, shipping Anki with extra steps.
 *
 * The benchmark behind it: the best model tested produced 64.3% usable cards,
 * and the dangerous tier is not the obviously-wrong card — models catch those —
 * but the **structurally broken one that looks fine** and quietly degrades over
 * months of review. Since `reviews` is append-only and FSRS derives state from
 * it, a bad card is not a wasted session; it compounds.
 *
 * Three deliberate choices in this screen:
 *
 * **It never sweeps without being asked, and it says what the sweep will
 * cost.** Grading is a real charge, and a screen that starts spending on mount
 * is a screen that spends while somebody is deciding whether to use it.
 *
 * **It can be stopped mid-sweep**, and everything already graded is kept. A
 * thousand batches is a long operation and a person who changes their mind
 * should not lose the first three hundred.
 *
 * **It lists problems, not cards.** Tier 3 never appears. A list that includes
 * everything that is fine is one nobody reads to the bottom of.
 */
export function DoctorPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { client } = useAuth()
  const { decks } = useDecks()
  const [params, setParams] = useSearchParams()

  const deckId = params.get('deck') || null
  const [pending, setPending] = useState<number | null>(null)
  const [state, setState] = useState<{ graded: number; flagged: number }>({ graded: 0, flagged: 0 })
  const [rows, setRows] = useState<doctor.FlaggedCard[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const stop = useRef(false)

  const refresh = useCallback(async () => {
    await collectionReady
    const [count, summary, flagged] = await Promise.all([
      doctor.pendingCount(deckId),
      doctor.summary(deckId),
      doctor.flagged(deckId),
    ])
    setPending(count)
    setState(summary)
    setRows(flagged)
  }, [deckId])

  useEffect(() => void refresh(), [refresh])

  async function sweep() {
    stop.current = false
    setRunning(true)
    setError(null)

    const total = pending ?? 0
    setProgress({ done: 0, total })

    try {
      for (;;) {
        if (stop.current) break
        const batch = await doctor.needsGrading(deckId)
        if (!batch.length) break

        const { verdicts } = await client.aiGrade(
          batch.map((c) => ({ id: c.id, fields: c.fields })),
        )
        await doctor.saveVerdicts(verdicts, new Map(batch.map((c) => [c.id, c.fingerprint])))

        setProgress((p) => ({ done: p.done + batch.length, total }))
        await refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      await refresh()
    }
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="font-display text-4xl tracking-tight">Card doctor</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This one needs an account, because the allowance it spends is counted per
          account.
        </p>
      </div>
    )
  }

  const batches = Math.ceil((pending ?? 0) / GRADE_BATCH)

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-8">
        <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => navigate(paths.decks)}>
          <ArrowLeft /> Decks
        </Button>
        <h1 className="flex items-center gap-2 font-display text-4xl tracking-tight">
          <Stethoscope className="size-7 text-hematoxylin" /> Card doctor
        </h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Reads your cards and says which prompts do not work as memory tests — ambiguous,
          more than one right answer, shallow, wordy, or a fragment of a fact. It only
          names problems; it never changes a card.
        </p>
      </header>

      <section className="mb-8 flex flex-wrap items-end gap-4 border-y border-border py-4">
        <div className="space-y-1.5">
          <p className="text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase">Deck</p>
          <Select
            value={deckId ?? 'all'}
            onValueChange={(v) => setParams(v === 'all' ? {} : { deck: v })}
          >
            <SelectTrigger size="sm" className="w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everything</SelectItem>
              {(decks ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 text-xs text-muted-foreground">
          {pending === null ? (
            'Counting…'
          ) : pending === 0 ? (
            state.graded ? 'Everything here has been looked at.' : 'No cards in this deck.'
          ) : (
            <>
              <strong className="font-medium text-foreground">{pending.toLocaleString()}</strong>{' '}
              {pending === 1 ? 'card' : 'cards'} to check — {batches} {batches === 1 ? 'batch' : 'batches'}.
              {' '}Twenty cards go up per batch.
            </>
          )}
        </div>

        {running ? (
          <Button variant="outline" onClick={() => { stop.current = true }}>
            <Square /> Stop
          </Button>
        ) : (
          <Button disabled={!pending} onClick={() => void sweep()}>
            <Stethoscope /> Check {deckId ? 'this deck' : 'everything'}
          </Button>
        )}
      </section>

      {running && (
        <div className="mb-8 space-y-2">
          <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} />
          <p className="font-mono text-xs text-muted-foreground">
            {progress.done.toLocaleString()} / {progress.total.toLocaleString()} checked.
            Stopping keeps everything already done.
          </p>
        </div>
      )}

      {error && <p className="mb-6 font-mono text-xs text-eosin">{error}</p>}

      {state.graded > 0 && (
        <p className="mb-4 text-sm text-muted-foreground">
          {state.flagged === 0
            ? `${state.graded.toLocaleString()} cards checked, nothing flagged.`
            : `${state.flagged.toLocaleString()} of ${state.graded.toLocaleString()} checked cards are worth a second look.`}
        </p>
      )}

      <ul>
        {rows.map((row) => (
          <li key={row.note_id} className="flex items-start gap-3 border-b border-border py-3 last:border-0">
            <Badge variant="outline" className={TIER[row.tier]?.className}>
              {TIER[row.tier]?.label ?? 'weak'}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{row.preview}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {row.reason || DIMENSION[row.dimension] || 'Worth a second look.'}
              </p>
              <p className="mt-0.5 font-mono text-[0.625rem] text-muted-foreground">{row.deck}</p>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.preview}`}
                    onClick={() => navigate(paths.note(row.note_id))}>
              <Pencil />
            </Button>
          </li>
        ))}
        {!rows.length && state.graded > 0 && (
          <li className="py-10 text-center text-sm text-muted-foreground">
            Nothing flagged. These prompts hold up.
          </li>
        )}
      </ul>
    </div>
  )
}
