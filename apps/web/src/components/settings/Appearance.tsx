import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useSfx } from '@/hooks/useSfx'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { resolvedTheme, setTheme, theme, type Theme } from '@/lib/theme'

const CHOICES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

/**
 * Three buttons rather than a switch: "system" is a real third answer, and a
 * two-state toggle forces a person who has one to pick a side (UI.md §4).
 *
 * Three `Button`s rather than shadcn's ToggleGroup, which is not installed —
 * `role="radiogroup"` is what the toggle group would render anyway, and adding
 * a dependency for three buttons is not a trade this screen needs to make.
 */
export function Appearance() {
  const [choice, setChoice] = useState<Theme>(theme)
  const { enabled: sound, setEnabled: setSound } = useSfx()

  function pick(next: Theme) {
    setTheme(next)
    setChoice(next)
  }

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-2">
        {CHOICES.map(({ value, label, icon: Icon }) => (
          <Button
            key={value}
            role="radio"
            aria-checked={choice === value}
            variant={choice === value ? 'default' : 'outline'}
            onClick={() => pick(value)}
          >
            <Icon /> {label}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {choice === 'system'
          ? `Following this device, which is currently ${resolvedTheme()}. It changes with the device, including on a schedule.`
          : `Always ${choice}, on this browser, whatever the device is set to.`}
      </p>
      <p className="text-sm text-muted-foreground">
        The choice is stored per browser and applied before the page draws, so there is no flash
        of the wrong palette on the way in. It is not synced — a desktop in a bright room and a
        phone in bed rarely want the same answer.
      </p>

      <Separator />

      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="sfx" className="text-sm font-medium">Sound effects</Label>
          <p className="mt-1 text-sm text-muted-foreground">
            Clicks and blips while you study — the flip, each rating, undo. Off by default, and it
            stays on this device.
          </p>
        </div>
        <Switch id="sfx" checked={sound} onCheckedChange={setSound} />
      </div>
    </div>
  )
}
