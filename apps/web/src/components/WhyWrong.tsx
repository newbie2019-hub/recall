import { useState } from 'react'
import { Lightbulb, Loader2 } from 'lucide-react'
import type { ApiError } from '@recall/core'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import type * as repo from '@/db/repo'

/**
 * "Why was I wrong?" — one explanation, at the moment of a lapse.
 *
 * This is the AI feature the evidence actually supports. Elaborative
 * interrogation and self-explanation are established effects, and they want
 * precisely what a model is good at: prose, on demand, about one specific
 * error. Everything else in the phase is downstream of the meter; this is the
 * feature the meter shipped with.
 *
 * Four rules it is built to obey, all of them load-bearing:
 *
 * **It never sits between a rating and the next card.** The button appears on
 * the answer side and is pressed on purpose. The study loop never waits for it,
 * and rating the card does not either. This app's first promise is that it
 * works on a plane.
 *
 * **It is disabled offline, with the reason.** Not hidden — a control that
 * vanishes teaches people the app is unreliable, where one that explains
 * itself teaches them what it needs.
 *
 * **It never touches scheduling.** No interval moves and no card is
 * rescheduled. FSRS is fitted; a model is not.
 *
 * **It renders as text.** The server constrains the answer to two plain
 * strings via a strict tool, and this puts them in a `<p>`. There is no
 * `dangerouslySetInnerHTML` here and there must not be — card HTML gets an
 * iframe because it is untrusted, and model output is untrusted twice.
 */
export function WhyWrong({ card }: { card: repo.StudyCard }) {
  const { user, status, client } = useAuth()
  const [answer, setAnswer] = useState<{ explanation: string; confusable_with: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // No account, no allowance to spend — the quota is counted per account.
  if (!user) return null

  const offline = status === 'paused'

  async function ask() {
    setBusy(true)
    setError(null)
    try {
      setAnswer(await client.aiExplain({
        fields: card.note.fields,
        deck: card.deckName,
        lapses: card.card.lapses,
      }))
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  if (answer) {
    return (
      <div className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lightbulb className="size-3.5" /> Why it works
        </p>
        <p>{answer.explanation}</p>
        {answer.confusable_with && (
          <p className="text-muted-foreground">
            <span className="text-foreground">Often confused with:</span>{' '}
            {answer.confusable_with}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="mt-4 border-t border-border pt-4">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        disabled={busy || offline}
        onClick={() => void ask()}
        title={offline ? 'This one needs the network. Everything else here does not.' : undefined}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Lightbulb />}
        {busy ? 'Thinking…' : offline ? 'Why was I wrong? (needs the network)' : 'Why was I wrong?'}
      </Button>
      {error && <p className="mt-2 text-xs text-eosin">{error}</p>}
    </div>
  )
}

/**
 * The server sends a different code for each thing a person can *do* about it,
 * so say the thing rather than the code.
 */
function message(e: unknown): string {
  const code = (e as ApiError | undefined)?.code
  switch (code) {
    case 'ai_consent_required':
      return 'Turn on AI features in Settings first — nothing is sent until you do.'
    case 'ai_quota_exceeded':
      return 'That is this month\'s AI allowance spent. It resets at the start of your next period.'
    case 'ai_unavailable':
      return 'This server has no AI configured.'
    case 'offline':
      return 'No connection. Everything else on this screen still works.'
    default:
      return e instanceof Error ? e.message : String(e)
  }
}
