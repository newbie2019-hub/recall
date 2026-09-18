import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import * as repo from '@/db/repo'
import { defaultFieldMap, type NoteType } from '@recall/core'

/**
 * Change a note's type — Anki's own flow, and the repair path when an import
 * maps a deck badly (CARDS.md §7).
 *
 * Both maps are explicit and both are shown, because the failure mode is
 * silent: a field mapped to the wrong box looks like a note someone typed
 * wrong, months later, with no way back to what it was.
 */

const NOTHING = '— nothing —'
const LABEL = 'text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase'

export function ChangeNoteType({
  noteId, from, open, onClose, onDone,
}: {
  noteId: string
  from: NoteType
  open: boolean
  onClose: () => void
  onDone: (toTypeId: string) => void
}) {
  const [types, setTypes] = useState<NoteType[]>([])
  const [toId, setToId] = useState<string | null>(null)
  const [fieldMap, setFieldMap] = useState<Record<string, string | null>>({})
  const [templateMap, setTemplateMap] = useState<Record<number, number | null>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) void repo.noteTypes().then(setTypes)
  }, [open])

  const to = types.find((t) => t.id === toId)

  // Same name wins, then same position — the defaults are right often enough
  // that the dialog is usually a confirmation rather than a form.
  useEffect(() => {
    if (!to) return
    setFieldMap(defaultFieldMap(from, to))
    setTemplateMap(Object.fromEntries(
      from.templates.map((_, ord) => [ord, to.kind === 'standard' && ord < to.templates.length ? ord : null]),
    ))
  }, [to, from])

  async function apply() {
    if (!to) return
    setBusy(true)
    try {
      await repo.changeNoteType([noteId], to.id, fieldMap, templateMap)
      toast(`Now a ${to.name} note`)
      onDone(to.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Change note type</DialogTitle>
          <DialogDescription>
            Cards whose template is kept keep their review history. The rest are
            regenerated from the new type.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className={LABEL}>New type</Label>
          <Select value={toId ?? ''} onValueChange={setToId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a note type" />
            </SelectTrigger>
            <SelectContent>
              {types.filter((t) => t.id !== from.id)
                    .map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {to && (
          <>
            <section className="space-y-2">
              <h3 className={`font-sans ${LABEL}`}>Fields</h3>
              {to.fields.map((name) => (
                <div key={name} className="flex items-center gap-2">
                  <span className="w-1/3 truncate text-sm">{name}</span>
                  <span className="text-muted-foreground">←</span>
                  <Select value={fieldMap[name] ?? NOTHING}
                          onValueChange={(v) =>
                            setFieldMap((m) => ({ ...m, [name]: v === NOTHING ? null : v }))}>
                    <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NOTHING}>{NOTHING}</SelectItem>
                      {from.fields.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </section>

            {to.kind === 'standard' && (
              <section className="space-y-2">
                <h3 className={`font-sans ${LABEL}`}>Cards</h3>
                {from.templates.map((t, ord) => (
                  <div key={ord} className="flex items-center gap-2">
                    <span className="w-1/3 truncate text-sm">{t.name}</span>
                    <span className="text-muted-foreground">→</span>
                    <Select value={templateMap[ord] === null || templateMap[ord] === undefined
                              ? NOTHING : String(templateMap[ord])}
                            onValueChange={(v) =>
                              setTemplateMap((m) => ({ ...m, [ord]: v === NOTHING ? null : Number(v) }))}>
                      <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NOTHING}>{NOTHING}</SelectItem>
                        {to.templates.map((tt, i) =>
                          <SelectItem key={i} value={String(i)}>{tt.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </section>
            )}

            {to.kind !== 'standard' && (
              <p className="text-xs text-muted-foreground">
                A {to.kind} type makes one card per {to.kind === 'cloze' ? 'deletion' : 'shape'},
                so its cards are generated rather than mapped.
              </p>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!to || busy} onClick={() => void apply()}>
            {busy ? 'Changing…' : 'Change type'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
