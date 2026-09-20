import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, Copy, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import * as repo from '@/db/repo'
import {
  addField, moveField, removeField, renameField, type CardTemplate, type NoteType,
} from '@recall/core'

/**
 * Note type management — fields, templates, sort field and CSS.
 *
 * PLAN.md §0 is explicit that normal users never meet a template editor, and
 * that stays true: this screen is reached deliberately, built-in types are
 * read-only in it, and the template source sits behind "Advanced". It exists
 * because an import brings note types whose fields have to survive a rename,
 * and because a badly mapped import needs a repair path (CARDS.md §7).
 */

const LABEL = 'text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase'
const NO_OVERRIDE = '— follow the note —'

const box =
  `w-full border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none
   focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40`

export function NoteTypes({ decks, onBack }: { decks: repo.DeckRow[]; onBack: () => void }) {
  const [types, setTypes] = useState<NoteType[]>([])
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<NoteType | null>(null)
  /** Original field name → its name now. Only the editor knows which edit a
   *  name change was: by save time, a rename and a delete-plus-add look the
   *  same and mean opposite things for every note's content. */
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const all = await repo.noteTypes()
    setTypes(all)
    setUsage(Object.fromEntries(
      await Promise.all(all.map(async (t) => [t.id, await repo.noteTypeUsage(t.id)] as const)),
    ))
  }, [])

  useEffect(() => void load(), [load])

  const open = (t: NoteType) => {
    setSelected(t.id)
    setDraft(t)
    setRenames({})
    setAdvanced(false)
  }

  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(types.find((t) => t.id === draft.id))

  const rename = (from: string, to: string) => {
    if (!draft) return
    try {
      setDraft(renameField(draft, from, to))
    } catch (e) {
      return toast(e instanceof Error ? e.message : String(e))
    }
    setRenames((r) => {
      // Rename A→B then B→C has to arrive at A→C, or the note content follows
      // a field name that no longer exists.
      const origin = Object.keys(r).find((k) => r[k] === from) ?? from
      return { ...r, [origin]: to }
    })
  }

  const editTemplate = (i: number, patch: Partial<CardTemplate>) =>
    setDraft((d) => d && {
      ...d,
      templates: d.templates.map((t, j) => (j === i ? { ...t, ...patch } : t)),
    })

  async function save() {
    if (!draft) return
    setBusy(true)
    try {
      const moved = await repo.saveNoteType(draft, renames)
      await load()
      setRenames({})
      setSelected(null)
      setDraft(null)
      toast(moved ? `Saved — ${moved} note${moved === 1 ? '' : 's'} regenerated` : 'Saved')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function create(cloneOf?: NoteType) {
    const name = cloneOf ? `${cloneOf.name} copy` : 'New note type'
    try {
      const ntId = await repo.createNoteType(name, cloneOf?.id)
      const all = await repo.noteTypes()
      setTypes(all)
      const made = all.find((t) => t.id === ntId)
      if (made) open(made)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(t: NoteType) {
    try {
      await repo.deleteNoteType(t.id)
      if (selected === t.id) { setSelected(null); setDraft(null) }
      await load()
      toast(`Deleted ${t.name}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  if (!draft || !selected)
    return (
      <div className="mx-auto max-w-2xl">
        <Button variant="ghost" size="sm" className="-ml-2 mb-6" onClick={onBack}>
          <ChevronLeft /> Decks
        </Button>
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl tracking-tight">Note types</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              What fields a note has, and which cards it makes.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void create()}>
            <Plus /> New
          </Button>
        </header>

        <ul>
          {types.map((t) => (
            <li key={t.id} className="flex items-center gap-2 border-b border-border py-3 last:border-0">
              <button className="flex-1 text-left text-sm hover:text-hematoxylin" onClick={() => open(t)}>
                {t.name}
                <span className="ml-2 font-mono text-[0.625rem] text-muted-foreground">
                  {t.fields.length} field{t.fields.length === 1 ? '' : 's'} ·{' '}
                  {usage[t.id] ?? 0} note{usage[t.id] === 1 ? '' : 's'}
                  {t.builtin ? ' · built-in' : ''}
                </span>
              </button>
              <Button variant="ghost" size="icon-sm" aria-label={`Clone ${t.name}`}
                      onClick={() => void create(t)}>
                <Copy />
              </Button>
              {!t.builtin && (
                <Button variant="ghost" size="icon-sm" aria-label={`Delete ${t.name}`}
                        onClick={() => void remove(t)}>
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    )

  const single = draft.kind !== 'standard'

  return (
    <div className="mx-auto max-w-3xl">
      <Button variant="ghost" size="sm" className="-ml-2 mb-6"
              onClick={() => { setSelected(null); setDraft(null) }}>
        <ChevronLeft /> Note types
      </Button>

      <div className="mb-6 space-y-1.5">
        <Label className={LABEL}>Name</Label>
        <Input value={draft.name} disabled={draft.builtin}
               onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        {draft.builtin && (
          <p className="text-xs text-muted-foreground">
            Built-in types are fixed — clone this one to change it.
          </p>
        )}
      </div>

      <Separator className="my-6" />

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className={`font-sans ${LABEL}`}>Fields</h2>
          <Button variant="ghost" size="sm" className="ml-auto" disabled={draft.builtin}
                  onClick={() => {
                    try {
                      setDraft(addField(draft, `Field ${draft.fields.length + 1}`))
                    } catch (e) {
                      toast(e instanceof Error ? e.message : String(e))
                    }
                  }}>
            <Plus /> Add field
          </Button>
        </div>

        <ul className="space-y-2">
          {draft.fields.map((f, i) => (
            <li key={`${i}-${f}`} className="flex items-center gap-1.5">
              <span className="w-6 font-mono text-xs text-muted-foreground">{i + 1}</span>
              <Input value={f} disabled={draft.builtin} className="flex-1"
                     aria-label={`Field ${i + 1} name`}
                     onChange={(e) => rename(f, e.target.value)} />
              <Button variant="ghost" size="icon-sm" aria-label={`Move ${f} up`}
                      disabled={draft.builtin || i === 0}
                      onClick={() => setDraft(moveField(draft, f, i - 1))}><ArrowUp /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Move ${f} down`}
                      disabled={draft.builtin || i === draft.fields.length - 1}
                      onClick={() => setDraft(moveField(draft, f, i + 1))}><ArrowDown /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${f}`}
                      disabled={draft.builtin || draft.fields.length === 1}
                      onClick={() => {
                        try {
                          setDraft(removeField(draft, f))
                        } catch (e) {
                          toast(e instanceof Error ? e.message : String(e))
                        }
                      }}><Trash2 /></Button>
            </li>
          ))}
        </ul>

        <div className="space-y-1.5 pt-2">
          <Label className={LABEL}>Sort field</Label>
          {/* Which field the card browser shows and sorts by. "First non-empty"
              is wrong for any type whose first field is an id or an image. */}
          <Select value={String(draft.sortField ?? 0)}
                  onValueChange={(v) => setDraft({ ...draft, sortField: Number(v) })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {draft.fields.map((f, i) => <SelectItem key={i} value={String(i)}>{f}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </section>

      <Separator className="my-6" />

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className={`font-sans ${LABEL}`}>
            Cards {single && <span className="normal-case tracking-normal">· one template, many cards</span>}
          </h2>
          <Button variant="ghost" size="sm" className="ml-auto"
                  onClick={() => setAdvanced((a) => !a)}>
            {advanced ? 'Hide' : 'Advanced'}
          </Button>
          {!single && (
            <Button variant="ghost" size="sm" disabled={draft.builtin}
                    onClick={() => setDraft({
                      ...draft,
                      templates: [...draft.templates, {
                        name: `Card ${draft.templates.length + 1}`,
                        qfmt: `{{${draft.fields[0]}}}`,
                        afmt: '{{FrontSide}}\n<hr id="answer">\n' +
                              `{{${draft.fields[1] ?? draft.fields[0]}}}`,
                      }],
                    })}>
              <Plus /> Add card
            </Button>
          )}
        </div>

        <ul className="space-y-4">
          {draft.templates.map((t, i) => (
            <li key={i} className="space-y-2 border border-border p-3">
              <div className="flex items-center gap-1.5">
                <Input value={t.name} disabled={draft.builtin} className="flex-1"
                       aria-label={`Card ${i + 1} name`}
                       onChange={(e) => editTemplate(i, { name: e.target.value })} />
                {!single && draft.templates.length > 1 && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${t.name}`}
                          disabled={draft.builtin}
                          onClick={() => setDraft({
                            ...draft,
                            templates: draft.templates.filter((_, j) => j !== i),
                          })}><Trash2 /></Button>
                )}
              </div>

              {!single && (
                <div className="space-y-1.5">
                  <Label className={LABEL}>Send its cards to</Label>
                  {/* Anki's per-template deck override: the classic case is a
                      reversed card going to its own recognition deck. */}
                  <Select value={t.deckOverride ?? NO_OVERRIDE}
                          onValueChange={(v) =>
                            editTemplate(i, { deckOverride: v === NO_OVERRIDE ? null : v })}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_OVERRIDE}>{NO_OVERRIDE}</SelectItem>
                      {decks.map((d) => <SelectItem key={d.id} value={d.id}>{d.path}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {advanced && (['qfmt', 'afmt'] as const).map((side) => (
                <div key={side} className="space-y-1.5">
                  <Label className={LABEL}>{side === 'qfmt' ? 'Front template' : 'Back template'}</Label>
                  <textarea rows={5} className={box} value={t[side]} readOnly={draft.builtin}
                            aria-label={`${t.name} ${side === 'qfmt' ? 'front' : 'back'} template`}
                            onChange={(e) => editTemplate(i, { [side]: e.target.value })} />
                </div>
              ))}
            </li>
          ))}
        </ul>

        {advanced && (
          <div className="space-y-1.5">
            <Label className={LABEL}>Styling</Label>
            <textarea rows={6} className={box} value={draft.css} readOnly={draft.builtin}
                      aria-label="Note type CSS"
                      onChange={(e) => setDraft({ ...draft, css: e.target.value })} />
          </div>
        )}
      </section>

      <div className="mt-8 flex items-center gap-2">
        <Button size="lg" className="flex-1" disabled={!dirty || busy || draft.builtin}
                onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save note type'}
        </Button>
        {(usage[draft.id] ?? 0) > 0 && dirty && (
          <p className="text-xs text-muted-foreground">
            {usage[draft.id]} note{usage[draft.id] === 1 ? '' : 's'} will be regenerated
          </p>
        )}
      </div>
    </div>
  )
}
