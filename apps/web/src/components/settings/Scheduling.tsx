import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { collectionReady } from '@/db/boot'
import { schedulingDefaults, setSchedulingDefaults } from '@/db/queries/settings'
import { paths } from '@/routes/paths'

/** The retentions FSRS is actually worth tuning between; below 0.8 nothing sticks. */
const RETENTIONS = ['0.8', '0.85', '0.9', '0.95'] as const

/**
 * The values a *new* deck starts from.
 *
 * Not a second copy of the per-deck options — those already live in the deck
 * browser and are the ones that schedule cards. Changing a default here does
 * nothing to a deck that already exists, which is the whole point: someone who
 * tuned one deck should not have it retuned from a settings page.
 */
export function Scheduling() {
  const [retention, setRetention] = useState('0.9')
  const [newPerDay, setNewPerDay] = useState('20')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      await collectionReady
      const d = await schedulingDefaults()
      setRetention(String(d.retention))
      setNewPerDay(String(d.newPerDay))
      setLoaded(true)
    })()
  }, [])

  async function save() {
    setBusy(true)
    try {
      await setSchedulingDefaults(Number(retention), Number(newPerDay))
      const saved = await schedulingDefaults()
      setRetention(String(saved.retention))
      setNewPerDay(String(saved.newPerDay))
      toast('New decks will start from these.')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="retention">Desired retention</Label>
          <Select value={retention} onValueChange={setRetention} disabled={!loaded}>
            <SelectTrigger id="retention" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RETENTIONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {Math.round(Number(r) * 100)}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            The share of cards you want to still remember when they come back. Higher means
            shorter intervals and more reviews a day, not better memory.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="new-per-day">New cards a day</Label>
          <Input
            id="new-per-day"
            type="number"
            inputMode="numeric"
            min={0}
            max={9999}
            disabled={!loaded}
            value={newPerDay}
            onChange={(e) => setNewPerDay(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Each new card costs roughly ten reviews over the following month, so this is the dial
            that sets tomorrow's workload.
          </p>
        </div>
      </div>

      <Button disabled={busy || !loaded} onClick={() => void save()}>Save defaults</Button>

      <p className="text-sm text-muted-foreground">
        These apply to decks created from here on. To change a deck you already have, open it
        from the <Link className="underline" to={paths.decks}>deck list</Link> and edit its
        options there.
      </p>
    </div>
  )
}
