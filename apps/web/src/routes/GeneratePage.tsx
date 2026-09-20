import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ArrowLeft, Check, FileText, Loader2, Sparkles, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import type { AiCandidate, AiJob } from '@recall/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { collectionReady } from '@/db/boot'
import * as repo from '@/db/repo'
import { useDecks } from '@/hooks/useDecks'
import { refreshDecks } from '@/hooks/useDecks'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { paths } from './paths'

/**
 * A document in, cards you chose to keep out.
 *
 * **The approval screen is the feature, not a step in front of it.** The
 * benchmark this phase is built on found the best model producing 64.3% usable
 * cards — and the unusable ones are the plausible-looking ones, so a person
 * skimming sixty suggestions cannot be the filter. The grader already dropped
 * everything it called broken or structurally weak before this screen loaded;
 * what is left still arrives **unselected**, because a wall of pre-ticked cards
 * *is* the rubber stamp.
 *
 * There is no "select all" and that omission is deliberate. `reviews` is
 * append-only and FSRS derives its state from it, so a bad card does not waste
 * one session — it compounds through the scheduler, permanently.
 *
 * Each candidate shows the passage it came from. A citation is for the
 * reviewer, not for the deck: it is discarded the moment a card is accepted.
 */
export function GeneratePage() {
  const navigate = useNavigate()
  const { user, client } = useAuth()
  const { decks } = useDecks()
  const [params] = useSearchParams()

  const [job, setJob] = useState<AiJob | null>(null)
  const [candidates, setCandidates] = useState<AiCandidate[] | null>(null)
  const [keep, setKeep] = useState<Set<string>>(new Set())
  const [deckId, setDeckId] = useState<string>(params.get('deck') ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!deckId && decks?.length) setDeckId(decks[0]!.id)
  }, [decks, deckId])

  /** Poll while the job is running, exactly as the `.apkg` import screen does. */
  useEffect(() => {
    if (!job || ['done', 'failed', 'partial'].includes(job.status)) return
    const timer = setTimeout(async () => {
      try {
        setJob(await client.aiJob(job.id))
      } catch {
        // A dropped poll is not a failed job. The next tick asks again.
      }
    }, 1500)
    return () => clearTimeout(timer)
  }, [job, client])

  /** Once it has finished, fetch what survived grading. */
  useEffect(() => {
    if (!job || !['done', 'partial'].includes(job.status) || candidates) return
    void client.aiCandidates(job.id).then(
      ({ candidates }) => setCandidates(candidates),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    )
  }, [job, candidates, client])

  const upload = useCallback(async (file: File) => {
    setBusy(true)
    setError(null)
    setCandidates(null)
    setKeep(new Set())
    try {
      setJob(await client.aiCreateJob(file))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [client])

  async function accept() {
    if (!job || !deckId) return
    setBusy(true)
    try {
      const { notes } = await client.aiAccept(job.id, [...keep])
      await collectionReady

      // Through the ordinary note path — the same one `NoteEditor` uses — so
      // these get real GUIDs, generate their cards normally, bury siblings,
      // export to Anki and sync like anything else. A private insert here
      // would surface months later as duplicates after an import.
      let written = 0
      for (const note of notes) {
        const noteType = await repo.noteTypeByName(note.note_type)
        if (!noteType) continue
        await repo.saveNote({
          noteTypeId: noteType.id,
          deckId,
          fields: note.fields,
          tags: note.tags,
        })
        written++
      }

      refreshDecks()
      toast(`${written} ${written === 1 ? 'card' : 'cards'} added.`, {
        action: { label: 'Open deck', onClick: () => navigate(paths.deck(deckId)) },
      })
      setJob(null)
      setCandidates(null)
      setKeep(new Set())
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function discard() {
    if (job) await client.aiDeleteJob(job.id).catch(() => {})
    setJob(null)
    setCandidates(null)
    setKeep(new Set())
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="font-display text-4xl tracking-tight">Make cards from a document</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This needs an account, because the allowance it spends is counted per account.
        </p>
      </div>
    )
  }

  const running = job !== null && !['done', 'failed', 'partial'].includes(job.status)

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-8">
        <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => navigate(paths.decks)}>
          <ArrowLeft /> Decks
        </Button>
        <h1 className="flex items-center gap-2 font-display text-4xl tracking-tight">
          <Sparkles className="size-7 text-hematoxylin" /> Cards from a document
        </h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          A PDF, a .txt or a .md file. Every suggestion is graded before you see it, and the
          ones that do not work as memory prompts are thrown away rather than shown. Nothing
          is added to your collection until you pick it.
        </p>
      </header>

      {!job && (
        <section className="rounded-md border border-dashed border-border py-14 text-center">
          <FileText className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm">Lecture notes, a paper, a chapter.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            A scanned PDF will not work — reading pictures of text needs OCR, which this
            does not do yet.
          </p>
          <Button className="mt-5" disabled={busy} onClick={() => picker.current?.click()}>
            <Upload /> Choose a file
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".pdf,.txt,.md,text/plain,text/markdown,application/pdf"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void upload(file)
            }}
          />
        </section>
      )}

      {error && <p className="mt-4 font-mono text-xs text-eosin">{error}</p>}

      {job && running && (
        <section className="space-y-3 border-y border-border py-8">
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Reading {job.source_name}…
          </p>
          <Progress value={job.total ? (job.done / job.total) * 100 : 0} />
          <p className="font-mono text-xs text-muted-foreground">
            {job.done} / {job.total} sections · about ${(job.estimated_micros / 1_000_000).toFixed(3)} of
            your allowance
          </p>
        </section>
      )}

      {job?.status === 'failed' && (
        <section className="space-y-3 border-y border-border py-8">
          <p className="text-sm text-eosin">{job.error ?? 'That document could not be read.'}</p>
          <Button variant="outline" onClick={() => void discard()}>Try another file</Button>
        </section>
      )}

      {candidates && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
            <div>
              <p className="text-sm">
                <strong className="font-medium">{candidates.length}</strong> suggestions survived
                grading{job?.status === 'partial' && ' (the run stopped early)'}.
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Nothing is selected. Pick the ones you would actually study.
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase">
                Add to
              </p>
              <Select value={deckId} onValueChange={setDeckId}>
                <SelectTrigger size="sm" className="w-52 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(decks ?? []).map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <ul className="space-y-2">
            {candidates.map((c) => {
              const on = keep.has(c.id)
              return (
                <li key={c.id}>
                  <button
                    onClick={() =>
                      setKeep((s) => {
                        const next = new Set(s)
                        if (!next.delete(c.id)) next.add(c.id)
                        return next
                      })
                    }
                    aria-pressed={on}
                    className={cn(
                      'flex w-full gap-3 rounded-md border p-3 text-left transition-colors',
                      on ? 'border-hematoxylin bg-hematoxylin/5' : 'border-border hover:bg-accent',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 grid size-4 shrink-0 place-items-center rounded-[3px] border',
                        on ? 'border-hematoxylin bg-hematoxylin text-background' : 'border-border',
                      )}
                      aria-hidden
                    >
                      {on && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{c.fields.Front}</span>
                      <span className="mt-0.5 block text-sm text-muted-foreground">{c.fields.Back}</span>
                      {c.tier === 2 && c.reason && (
                        <span className="mt-1.5 flex items-center gap-1.5">
                          <Badge variant="outline" className="text-muted-foreground">fixable</Badge>
                          <span className="text-xs text-muted-foreground">{c.reason}</span>
                        </span>
                      )}
                      {c.source_excerpt && (
                        <span className="mt-1.5 block border-l-2 border-border pl-2 text-xs text-muted-foreground italic">
                          {c.source_excerpt.slice(0, 180)}…
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
            {!candidates.length && (
              <li className="py-10 text-center text-sm text-muted-foreground">
                Nothing in that document made a prompt worth keeping. That is a real answer:
                a page of references or a contents list has no facts to test.
              </li>
            )}
          </ul>

          <div className="sticky bottom-0 flex items-center gap-3 border-t border-border bg-background py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Button variant="ghost" disabled={busy} onClick={() => void discard()}>
              <X /> Discard all
            </Button>
            <span className="flex-1" />
            <p className="font-mono text-xs text-muted-foreground">
              {keep.size} of {candidates.length} kept
            </p>
            <Button disabled={!keep.size || !deckId || busy} onClick={() => void accept()}>
              {busy ? 'Adding…' : `Add ${keep.size || ''}`.trim()}
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}
