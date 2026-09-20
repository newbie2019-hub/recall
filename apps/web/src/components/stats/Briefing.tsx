import { useState } from 'react'
import { Lightbulb, Loader2 } from 'lucide-react'
import type { AiBriefing } from '@recall/core'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'

/**
 * What the numbers on this screen mean together.
 *
 * **One component, not a registry.** PHASES §10 asked for five generative-UI
 * components bound to structured JSON — summary, comparison table, timeline,
 * concept map, weak-topic callout — and CRITIQUE scored that 8.5 and called it
 * a solution looking for a problem. This is the one. The registry is the
 * generalisation of a thing not yet shown to be worth building once.
 *
 * The model is handed figures the dashboard already computed and is forbidden
 * from producing any of its own. That is what makes it safe to put underneath
 * numbers whose entire value is that they came from the person's own review
 * log — one invented figure and the screen is worth nothing.
 *
 * Rendered as text. No `dangerouslySetInnerHTML` here or anywhere near model
 * output: card HTML gets a script-less iframe *because* it is untrusted, and
 * this is untrusted twice.
 */
export function Briefing({ figures }: { figures: Record<string, unknown> }) {
  const { user, status, client } = useAuth()
  const [brief, setBrief] = useState<AiBriefing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user) return null

  const offline = status === 'paused'

  async function ask() {
    setBusy(true)
    setError(null)
    try {
      setBrief(await client.aiBrief(figures))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (brief) {
    return (
      <section className="space-y-2 border-t border-border pt-4">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <Lightbulb className="size-3.5 text-hematoxylin" /> {brief.headline}
        </h2>
        <p className="max-w-prose text-sm">{brief.assessment}</p>
        <p className="max-w-prose text-sm text-muted-foreground">{brief.advice}</p>
        <p className="font-mono text-[0.6875rem] text-muted-foreground">
          Written over the figures above — it was given them and cannot compute its own.
        </p>
      </section>
    )
  }

  return (
    <section className="border-t border-border pt-4">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        disabled={busy || offline}
        onClick={() => void ask()}
        title={offline ? 'This one needs the network. The figures above do not.' : undefined}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Lightbulb />}
        {busy ? 'Reading your numbers…' : offline ? 'What does this mean? (needs the network)' : 'What does this mean?'}
      </Button>
      {error && <p className="mt-2 font-mono text-xs text-eosin">{error}</p>}
    </section>
  )
}
