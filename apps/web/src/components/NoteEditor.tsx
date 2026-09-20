import { useCallback, useEffect, useRef, useState } from 'react'
import { Bold, Code, Italic, Braces, ImagePlus, Mic, Pin, Repeat, Square, Sigma, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { CardFrame } from './CardFrame'
import { OcclusionEditor } from './OcclusionEditor'
import { ChangeNoteType } from './ChangeNoteType'
import * as repo from '@/db/repo'
import { PresenceBar } from '@/components/collab/PresenceBar'
import { useCollabSession } from '@/hooks/useCollabSession'
import { readNote } from '@/lib/collab/doc'
import { materialize, publishDeletion, publishNote } from '@/lib/collab/materialize'
import { mediaRef, storeMedia } from '@/lib/media'
import { paintCard, type PaintedCard } from '@/lib/render'
import { generatedOrds, type NoteType } from '@recall/core'

/**
 * One editor for every note type: the type decides the fields, not the layout.
 * Image occlusion is the single special case, because you draw its field rather
 * than type it.
 */

const CLOZE = /\{\{c(\d+)::/g

/**
 * A datalist offers whole values, but the tag box holds several tags. Suggest
 * "what is already typed, with this tag appended" so picking one adds a tag
 * rather than replacing the lot.
 */
function tagSuggestion(current: string, tag: string): string {
  const parts = current.split(/\s+/)
  parts[parts.length - 1] = tag
  return parts.filter(Boolean).join(' ')
}

/**
 * ponytail: `contentEditable` + `execCommand`. Deprecated and inconsistent
 * around edge cases, but it is ~40 lines against a rich-text editor dependency,
 * and the formatting a flashcard needs is bold, italic and an image. Swap for a
 * real editor the first time somebody wants tables.
 */
function FieldBox({
  name, value, onChange, onFocus, onInsertFile, sticky, onSticky, duplicate, html,
}: {
  name: string
  value: string
  onChange: (v: string) => void
  onFocus: () => void
  onInsertFile: (file: File) => void
  sticky: boolean
  onSticky: () => void
  duplicate?: boolean
  /** Show the field's markup instead of rendering it — the escape hatch. */
  html?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Only write back when the value came from somewhere else — writing on every
  // keystroke would put the caret at position zero.
  useEffect(() => {
    const el = ref.current
    if (el && el.innerHTML !== value) el.innerHTML = value
  }, [value])

  /**
   * Paste is how images actually arrive — a file picker is the slow path for the
   * most common action in the app.
   *
   * Text always pastes as plain text, which is Anki's default: copying from a
   * PDF or a lecture slide otherwise drags a stylesheet into the card, and that
   * stylesheet then renders inside the sandboxed frame. A paste event carries
   * no modifier state, so there is no "paste rich" shortcut to offer; the HTML
   * view is the escape hatch when one is needed.
   */
  const onPaste = (e: React.ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
    e.preventDefault()
    if (file) return onInsertFile(file)
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
  }

  const onDrop = (e: React.DragEvent) => {
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    onInsertFile(file)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
          {name}
        </Label>
        {duplicate && (
          <span className="font-mono text-[0.625rem] text-eosin">duplicate</span>
        )}
        <button
          type="button"
          onClick={onSticky}
          aria-pressed={sticky}
          title="Keep this field's value for the next note"
          className={`ml-auto rounded-xs p-0.5 ${sticky ? 'text-hematoxylin' : 'text-muted-foreground/50 hover:text-muted-foreground'}`}
        >
          <Pin className="size-3.5" />
          <span className="sr-only">Keep {name} for the next note</span>
        </button>
      </div>
      {html ? (
        // The HTML view is the way out of a paste that arrived wrong, and the
        // only way to type markup the toolbar has no button for. Same field,
        // same value, no rendering in between.
        <textarea
          role="textbox"
          aria-label={`${name} HTML`}
          value={value}
          onFocus={onFocus}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-20 w-full border border-input bg-transparent px-3 py-2 font-mono text-xs
                     outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
      ) : (
      <div
        ref={ref}
        role="textbox"
        aria-label={name}
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        onFocus={onFocus}
        onPaste={onPaste}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onInput={(e) => onChange(e.currentTarget.innerHTML)}
        className={`min-h-20 w-full border bg-transparent px-3 py-2 font-body text-base outline-none
                    focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40
                    ${duplicate ? 'border-eosin' : 'border-input'}`}
      />
      )}
    </div>
  )
}

export function NoteEditor({
  noteId, deckId, decks, onDone, onCancel,
}: {
  noteId?: string
  deckId: string
  decks: repo.DeckRow[]
  onDone: () => void
  onCancel: () => void
}) {
  const [types, setTypes] = useState<NoteType[]>([])
  const [typeId, setTypeId] = useState('basic')
  const [deck, setDeck] = useState(deckId)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [tags, setTags] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const [preview, setPreview] = useState<PaintedCard | null>(null)
  const [ord, setOrd] = useState(0)
  const [recording, setRecording] = useState<MediaRecorder | null>(null)
  const [sticky, setSticky] = useState<Set<string>>(new Set())
  const [dupes, setDupes] = useState(0)
  const [knownTags, setKnownTags] = useState<string[]>([])
  const [added, setAdded] = useState(0)
  const [rawHtml, setRawHtml] = useState(false)
  const [changing, setChanging] = useState(false)

  /**
   * The live session for the deck being edited, or an idle one for the usual
   * case of a deck nobody else is on (Phase 9).
   *
   * Its presence changes where a save *goes*: into the shared document, which
   * merges it with whatever a collaborator is typing and materialises the row
   * afterwards — never straight into `notes`, because a direct write is the one
   * thing that cannot merge.
   */
  const collab = useCollabSession(deck)
  const collaborative =
    collab.doc !== null && ['owner', 'admin', 'editor'].includes(collab.role ?? '')

  const nt = types.find((t) => t.id === typeId)

  useEffect(() => {
    void repo.allTags().then(setKnownTags)
  }, [added])

  // The duplicate warning is advisory, so it trails the typing rather than
  // blocking it. Duplicates are legal — they are just usually a mistake.
  useEffect(() => {
    if (!nt) return
    const t = setTimeout(() => void repo.duplicatesOf(nt, fields, noteId).then(setDupes), 250)
    return () => clearTimeout(t)
  }, [nt, fields, noteId])

  useEffect(() => {
    void (async () => {
      const all = await repo.noteTypes()
      setTypes(all)
      if (!noteId) return
      const note = await repo.getNote(noteId)
      if (!note) return
      setTypeId(note.note_type)
      setDeck(note.deck_id)
      setFields(note.fields)
      setTags(note.tags.join(' '))
    })()
  }, [noteId])

  /**
   * A collaborator's edit to the note on screen.
   *
   * The field with the cursor in it is deliberately left alone. Overwriting the
   * box somebody is typing in would throw away the characters between their
   * last keystroke and this repaint, and jump their caret — the document has
   * already merged both sides, so the only question here is when to show it,
   * and "not mid-word" is the answer.
   */
  useEffect(() => {
    if (!collab.doc || !noteId) return
    const remote = readNote(collab.doc, noteId)
    if (!remote) return

    setFields((current) => {
      let changed = false
      const next = { ...current }
      for (const [name, value] of Object.entries(remote.fields)) {
        if (name === active || (current[name] ?? '') === value) continue
        next[name] = value
        changed = true
      }
      return changed ? next : current
    })
  }, [collab.doc, collab.revision, noteId, active])

  // Switching note type keeps whatever field names the two share.
  useEffect(() => {
    if (!nt) return
    setFields((prev) => Object.fromEntries(nt.fields.map((f) => [f, prev[f] ?? ''])))
    // Sticky is the note type's, not the session's — pinning "Deck" once should
    // still be pinned tomorrow.
    setSticky(new Set(nt.fields.filter((_, i) => nt.fieldConfig?.[i]?.sticky)))
  }, [nt])

  const ords = nt ? generatedOrds(nt, fields) : []

  useEffect(() => {
    if (!nt) return setPreview(null)
    const target = ords.includes(ord) ? ord : (ords[0] ?? 0)
    if (target !== ord) setOrd(target)
    void paintCard(nt, fields, target, {
      deck: decks.find((d) => d.id === deck)?.path ?? '',
      tags: tags.split(/\s+/).filter(Boolean),
      typed: '',
    }).then(setPreview)
  }, [nt, fields, ord, deck, tags, decks, ords.join(',')])

  const edit = useCallback((name: string, v: string) => setFields((f) => ({ ...f, [name]: v })), [])

  /**
   * The editor's keyboard contract.
   *
   * Bound on the container rather than the window: a shortcut that fires while
   * the deck picker is open is a bug, and this way the browser's own Cmd-keys
   * keep working everywhere else on the page.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) {
      if (e.key === 'Escape') onCancel()
      return
    }
    const shift = e.shiftKey
    if (e.key === 'Enter') { e.preventDefault(); return void save() }
    if (shift && e.key.toLowerCase() === 'c') { e.preventDefault(); return insertCloze(!e.altKey) }
    if (e.key.toLowerCase() === 'm') { e.preventDefault(); return insertMath() }
    if (shift && e.key.toLowerCase() === 'x') { e.preventDefault(); return setRawHtml((v) => !v) }
    if (/^[1-9]$/.test(e.key)) {
      const boxes = e.currentTarget.querySelectorAll<HTMLElement>('[role=textbox]')
      const box = boxes[Number(e.key) - 1]
      if (box) { e.preventDefault(); box.focus() }
    }
  }

  /** Toolbar actions apply to whichever field had focus last. */
  const exec = (fn: () => void) => {
    if (!active) return toast('Put the cursor in a field first')
    fn()
  }

  /**
   * `advance` picks the next ordinal (a new card); otherwise it reuses the
   * highest one, which is how two spans are blanked as a single card.
   */
  const insertCloze = (advance = true) =>
    exec(() => {
      const highest = Math.max(0, ...Object.values(fields).flatMap((v) =>
        [...v.matchAll(CLOZE)].map((m) => Number(m[1]))))
      const n = advance ? highest + 1 : Math.max(1, highest)
      const text = document.getSelection()?.toString() ?? ''
      document.execCommand('insertText', false, `{{c${n}::${text}}}`)
    })

  const insertMath = () =>
    exec(() => {
      const text = document.getSelection()?.toString() ?? ''
      document.execCommand('insertText', false, `\\(${text}\\)`)
    })

  async function insertImage(file: File | undefined, intoField?: string) {
    if (!file) return
    if (intoField) setActive(intoField)
    else if (!active) return
    document.execCommand('insertHTML', false, `<img src="${mediaRef(await storeMedia(file))}">`)
  }

  async function toggleRecording() {
    if (recording) return recording.stop()
    if (!active) return toast('Put the cursor in a field first')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => chunks.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(null)
        const sha = await storeMedia(new Blob(chunks, { type: rec.mimeType }))
        // Anki's own `[sound:…]` syntax, so Phase 3 only has to swap the filename
        // for a hash on the way in and back again on the way out.
        document.execCommand('insertText', false, `[sound:${mediaRef(sha)}]`)
      }
      rec.start()
      setRecording(rec)
    } catch {
      toast('No microphone available')
    }
  }

  /**
   * Adding leaves you where you are; editing returns to the browser.
   *
   * Twenty cards should be one screen and twenty keystroke-runs, not twenty
   * navigations — so `Add` clears the non-sticky fields, keeps the note type,
   * the deck and the tags, and puts the cursor back in the first field.
   */
  async function save(andStay = !noteId) {
    if (!nt) return
    if (!ords.length) return toast('Nothing to save yet — this note generates no cards')
    const count = ords.length
    const savedId = collaborative && collab.doc
      ? await saveThroughDocument()
      : await repo.saveNote({
        id: noteId, noteTypeId: nt.id, deckId: deck, fields,
        tags: tags.split(/\s+/).filter(Boolean),
      })

    if (!andStay) {
      toast(noteId ? 'Note saved' : `Added ${count} card${count === 1 ? '' : 's'}`)
      return onDone()
    }

    toast(`Added ${count} card${count === 1 ? '' : 's'}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          void repo.deleteNote(savedId).then(() => toast('Note removed'))
        },
      },
    })
    setFields((f) =>
      Object.fromEntries(nt.fields.map((name) => [name, sticky.has(name) ? (f[name] ?? '') : ''])),
    )
    setOrd(0)
    setAdded((n) => n + 1)
    // Back to the top field, so the next note starts where the last one did.
    // Querying beats a forwarded ref here: the first textbox on the page *is*
    // the first field, for every note type including image occlusion.
    document.querySelector<HTMLElement>('[role=textbox]')?.focus()
  }

  /**
   * The shared-deck write path: into the document, then out to the row.
   *
   * A new note mints its id here rather than inside `repo.saveNote`, because
   * the document needs a key before the row exists — and the id has to be the
   * same on both sides or the collaborator who receives this note would
   * materialise a second copy of it.
   */
  async function saveThroughDocument(): Promise<string> {
    const id = noteId ?? crypto.randomUUID()
    publishNote(collab.doc!, {
      id,
      noteTypeId: nt!.id,
      deckId: deck,
      fields,
      tags: tags.split(/\s+/).filter(Boolean).join(' '),
    })
    // Materialise straight away rather than waiting for the change callback, so
    // the row exists by the time this function returns — `Undo` and the browser
    // both assume a saved note is a note you can read back.
    await materialize(collab.doc!, deck)
    await collab.session?.flush()
    return id
  }

  async function remove() {
    if (!noteId) return
    // On a shared deck the deletion goes to everybody, because the note is
    // everybody's. `deleteNote` still runs: it is what removes the local cards
    // and writes the tombstone the rest of the app reads.
    if (collaborative && collab.doc) {
      publishDeletion(collab.doc, noteId)
      await collab.session?.flush()
    }
    await repo.deleteNote(noteId)
    toast('Note deleted')
    onDone()
  }

  return (
    <div className="mx-auto max-w-3xl" onKeyDown={onKeyDown}>
      {collab.status !== 'idle' && (
        <div className="mb-4">
          <PresenceBar
            members={collab.members}
            status={collab.status}
            queued={collab.session?.queued ?? 0}
          />
        </div>
      )}

      <header className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="font-display text-3xl">{noteId ? 'Edit note' : 'New note'}</h1>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {noteId ? 'Cancel' : 'Done'}
          <span className="font-mono text-[0.625rem] opacity-60">esc</span>
        </Button>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">Type</Label>
          <div className="flex gap-1.5">
            <Select value={typeId} onValueChange={setTypeId} disabled={!!noteId}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {/* An existing note's type is not a dropdown: changing it has to
                map fields and templates, or content lands in the wrong box. */}
            {noteId && (
              <Button variant="outline" size="icon" aria-label="Change note type"
                      title="Change note type" onClick={() => setChanging(true)}>
                <Repeat />
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">Deck</Label>
          <Select value={deck} onValueChange={setDeck}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {decks.map((d) => <SelectItem key={d.id} value={d.id}>{d.path}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Separator className="my-6" />

      {nt?.kind === 'occlusion' ? (
        <OcclusionEditor
          occlusion={fields.Occlusion ?? ''}
          image={fields.Image ?? ''}
          onChange={({ occlusion, image }) =>
            setFields((f) => ({ ...f, Occlusion: occlusion, Image: image }))}
        />
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-1">
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Bold"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec(() => document.execCommand('bold'))}><Bold /></Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Italic"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec(() => document.execCommand('italic'))}><Italic /></Button>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <Button type="button" size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertCloze(true)}><Braces /> Cloze</Button>
        <Button type="button" size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()}
                onClick={insertMath}><Sigma /> Maths</Button>
        <Button type="button" size="sm" variant="ghost" asChild>
          <label onMouseDown={(e) => e.preventDefault()}>
            <ImagePlus /> Image
            <input type="file" accept="image/*" className="sr-only"
                   onChange={(e) => void insertImage(e.target.files?.[0])} />
          </label>
        </Button>
        <Button type="button" size="sm" variant={recording ? 'again' : 'ghost'}
                onMouseDown={(e) => e.preventDefault()} onClick={() => void toggleRecording()}>
          {recording ? <><Square /> Stop</> : <><Mic /> Audio</>}
        </Button>
        <Button type="button" size="sm" variant={rawHtml ? 'secondary' : 'ghost'}
                aria-pressed={rawHtml} onMouseDown={(e) => e.preventDefault()}
                onClick={() => setRawHtml((v) => !v)}>
          <Code /> HTML
          <span className="font-mono text-[0.625rem] opacity-60">⌘⇧X</span>
        </Button>
      </div>

      <div className="mt-4 space-y-4">
        {nt?.fields
          .filter((f) => nt.kind !== 'occlusion' || !['Occlusion', 'Image'].includes(f))
          .map((f, i) => (
            <FieldBox
              key={f}
              name={f}
              value={fields[f] ?? ''}
              onChange={(v) => edit(f, v)}
              onFocus={() => setActive(f)}
              onInsertFile={(file) => void insertImage(file, f)}
              sticky={sticky.has(f)}
              onSticky={() => setSticky((prev) => {
                const next = new Set(prev)
                next.has(f) ? next.delete(f) : next.add(f)
                if (nt) void repo.setFieldSticky(nt.id, f, next.has(f))
                return next
              })}
              duplicate={i === 0 && dupes > 0}
              html={rawHtml}
            />
          ))}

        <div className="space-y-1.5">
          <Label htmlFor="tags" className="text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
            Tags
          </Label>
          {/* A datalist is the whole autocomplete: native, keyboard-accessible,
              and it does not steal the space key the way a combobox would. */}
          <Input id="tags" value={tags} onChange={(e) => setTags(e.target.value)}
                 list="known-tags" autoComplete="off"
                 placeholder="valves conduction" className="font-mono text-sm" />
          <datalist id="known-tags">
            {knownTags.map((t) => <option key={t} value={tagSuggestion(tags, t)} />)}
          </datalist>
        </div>
      </div>

      <Separator className="my-6" />

      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-sans text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
            Preview
          </h2>
          <span className="font-mono text-xs text-muted-foreground">
            {ords.length} card{ords.length === 1 ? '' : 's'}
          </span>
          <div className="ml-auto flex gap-1">
            {ords.length > 1 && ords.map((o) => (
              <Button key={o} type="button" size="sm" variant={o === ord ? 'secondary' : 'ghost'}
                      className="font-mono text-xs" onClick={() => setOrd(o)}>
                {o + 1}
              </Button>
            ))}
          </div>
        </div>

        {preview && ords.length ? (
          // Labelled sides, because the back legitimately repeats the front —
          // that is what {{FrontSide}} does, and an unlabelled repeat reads as
          // a bug.
          <div className="specimen-tag divide-y divide-border">
            {([['Front', preview.front], ['Back', preview.back]] as const).map(([label, html]) => (
              <div key={label} className="p-6">
                <p className="mb-3 font-sans text-[0.625rem] tracking-[0.18em] text-muted-foreground uppercase">
                  {label}
                </p>
                <CardFrame html={html} css={nt?.css ?? ''} />
              </div>
            ))}
          </div>
        ) : (
          <p className="border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No cards yet — fill in a field.
          </p>
        )}
      </section>

      <div className="mt-8 flex items-center gap-2">
        <Button size="lg" className="flex-1" onClick={() => void save()} disabled={!ords.length}>
          {noteId ? 'Save note' : 'Add note'}
          <span className="font-mono text-[0.625rem] opacity-60">⌘↵</span>
        </Button>
        {!noteId && (
          <Button size="lg" variant="outline" onClick={() => void save(false)} disabled={!ords.length}>
            Add and close
          </Button>
        )}
        {noteId && (
          <Button size="lg" variant="outline" onClick={() => void remove()} aria-label="Delete note">
            <Trash2 />
          </Button>
        )}
      </div>
      {noteId && nt && (
        <ChangeNoteType
          noteId={noteId}
          from={nt}
          open={changing}
          onClose={() => setChanging(false)}
          onDone={() => {
            setChanging(false)
            onDone()
          }}
        />
      )}
      {!noteId && added > 0 && (
        <p className="mt-3 text-center font-mono text-xs text-muted-foreground">
          {added} note{added === 1 ? '' : 's'} added this session
        </p>
      )}
    </div>
  )
}
