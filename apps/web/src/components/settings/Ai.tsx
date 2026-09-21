import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AiUsage } from '@recall/core'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/lib/auth'

/**
 * What AI costs, and the switch that turns it off.
 *
 * **The number is the point of this panel.** A subsystem that can spend money
 * on someone's behalf without showing them the running total is one they are
 * right not to trust, and AI.md ships the meter *before* the features for
 * exactly that reason. Every figure here is a `SUM` over the append-only
 * `ai_usage` log, which is the same query that would produce an invoice.
 *
 * The consent switch is not a formality either. This app's users chose an
 * offline-first product on purpose, and a medical student's cards are the most
 * sensitive content in it. Off is the default, nothing is sent until it is on,
 * and turning it off again takes every AI affordance in the app with it.
 */
export function Ai() {
  const { user, client } = useAuth()
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setUsage(await client.aiUsage())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [client])

  useEffect(() => {
    if (user) void load()
  }, [user, load])

  if (!user) {
    return (
      <p className="text-sm text-muted-foreground">
        AI features need an account, because the allowance is counted per account.
      </p>
    )
  }

  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Couldn't reach the server to read your usage. Nothing is spent while it is
          unreachable.
        </p>
        <p className="font-mono text-xs text-eosin">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
      </div>
    )
  }

  if (!usage) return <Skeleton className="h-40 w-full" />

  if (!usage.available) {
    return (
      <p className="text-sm text-muted-foreground">
        This server has no AI key configured, so the features are absent rather than
        broken. Nothing in the app will offer them.
      </p>
    )
  }

  async function toggle(enabled: boolean) {
    setBusy(true)
    try {
      setUsage(await client.aiConsent(enabled))
      toast(enabled ? 'AI features are on.' : 'AI features are off. Nothing will be sent.')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const used = usage.limit_micros ? Math.min(100, (usage.spent_micros / usage.limit_micros) * 100) : 0

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-sm font-medium">AI features</p>
            <p className="mt-1 max-w-prose text-xs text-muted-foreground">
              Off by default. When on, the card you ask about is sent to Anthropic to be
              explained — the fields only, with their formatting stripped. It is not used
              to train anything, nothing is stored there, and no other part of your
              collection is sent. Studying, syncing and everything else works exactly the
              same with this off.
            </p>
          </div>
          <Switch
            checked={usage.consented}
            disabled={busy}
            onCheckedChange={(v) => void toggle(v)}
            aria-label="AI features"
          />
        </div>
      </section>

      <section className="space-y-3 border-t border-border pt-6">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">This month</p>
          <p className="font-mono text-xs text-muted-foreground">
            {dollars(usage.spent_micros)} of {dollars(usage.limit_micros)}
          </p>
        </div>

        <Progress value={used} />

        <p className="text-xs text-muted-foreground">
          {usage.remaining_micros > 0
            ? `${dollars(usage.remaining_micros)} left, resetting ${new Date(usage.period_end).toLocaleDateString()}.`
            : `Allowance spent. It resets ${new Date(usage.period_end).toLocaleDateString()}.`}
        </p>

        {/* Named rather than silently deducted. An allowance that reads smaller
            than the calls listed below it is a number nobody can check. */}
        {usage.reserved_micros > 0 && (
          <p className="text-xs text-muted-foreground">
            {dollars(usage.reserved_micros)} of that is held for a document still being
            processed. It goes back if the run costs less than its estimate.
          </p>
        )}

        {/* Tokens, not only dollars. A price change reprices the whole history;
            "how much did I send" is the question that still has the same answer
            afterwards — and it is the number that can be read straight off the
            Anthropic console. */}
        {tokenTotal(usage.tokens) > 0 && (
          <p className="font-mono text-[0.6875rem] text-muted-foreground">
            {usage.tokens.input.toLocaleString()} in · {usage.tokens.output.toLocaleString()} out
            {usage.tokens.cache_read + usage.tokens.cache_write > 0 &&
              ` · ${(usage.tokens.cache_read + usage.tokens.cache_write).toLocaleString()} cached`}
            {' '}tokens
          </p>
        )}

        {Object.keys(usage.by_feature).length > 0 && (
          <dl className="grid gap-x-6 gap-y-1 pt-2 font-mono text-xs sm:grid-cols-2">
            {Object.entries(usage.by_feature).map(([feature, row]) => (
              <div key={feature} className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">
                  {FEATURE[feature] ?? feature}
                  <span className="ml-2 opacity-60">×{row.calls}</span>
                </dt>
                <dd className="tabular-nums" title={`${tokenTotal(row.tokens).toLocaleString()} tokens`}>
                  {dollars(row.micros)}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <p className="pt-2 text-xs text-muted-foreground">
          Counted from a log of every call, including the ones that failed or were
          refused — those are charged for too, so leaving them out would make this
          number quietly wrong.
        </p>
      </section>
    </div>
  )
}

/** The ledger's own names, said in English. */
const FEATURE: Record<string, string> = {
  explain: 'Explaining a lapse',
  grade: 'Grading cards',
  generate: 'Generating cards',
  brief: 'Weakness briefing',
  rewrite: 'Rewriting a card',
}

/** Cache reads and writes are tokens too — they are just priced differently. */
const tokenTotal = (t: AiUsage['tokens']) =>
  t.input + t.cache_write + t.cache_read + t.output

/** Four decimal places, because a call costs a fraction of a cent. */
const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`
