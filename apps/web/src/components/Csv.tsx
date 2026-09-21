import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  guessMapping, parseCsv, sniffDelimiter, toCsv,
  type CsvMapping, type Delimiter, type NoteType,
} from '@recall/core'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import * as repo from '@/db/repo'
import { importCsvNotes, exportCsv } from '@/lib/csvIo'

/**
 * CSV in and out, with the column mapping shown before anything is written.
 *
 * The mapping screen is the whole feature. Everybody's file is a different
 * shape, the guess is right often enough to be worth making and wrong often
 * enough that importing on the guess would turn a spreadsheet into five hundred
 * notes whose Front is their Back. So: guess, show what that produces, let it
 * be corrected, then import.
 */
const NONE = '—'

export function useCsv({ deckId, onImported }: { deckId?: string | null; onImported: () => void }) {
  const picker = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<string[][] | null>(null)
  const [delimiter, setDelimiter] = useState<Delimiter>(',')
  const [mapping, setMapping] = useState<CsvMapping | null>(null)
  const [types, setTypes] = useState<NoteType[]>([])
  const [typeId, setTypeId] = useState('basic')
  const [decks, setDecks] = useState<repo.DeckRow[]>([])
  const [target, setTarget] = useState<string>('')
  const [busy, setBusy] = useState(false)

  async function read(file: File) {
    const text = await file.text()
    const d = sniffDelimiter(text)
    const parsed = parseCsv(text, d)
    if (!parsed.length) return void toast('That file has no rows in it.')

    const [allTypes, allDecks] = await Promise.all([repo.noteTypes(), repo.deckTree()])
    const nt = allTypes.find((t) => t.id === typeId) ?? allTypes[0]!

    setTypes(allTypes)
    setTypeId(nt.id)
    setDecks(allDecks)
    setTarget(deckId ?? allDecks[0]?.id ?? '')
    setDelimiter(d)
    setRows(parsed)
    setMapping(guessMapping(parsed, nt.fields))
  }

  /** Re-guess when the note type changes: the old mapping names its fields. */
  function chooseType(id: string) {
    setTypeId(id)
    const nt = types.find((t) => t.id === id)
    if (nt && rows) setMapping(guessMapping(rows, nt.fields))
  }

  async function run() {
    if (!rows || !mapping || !target) return
    setBusy(true)
    try {
      const n = await importCsvNotes(rows, mapping, typeId, target)
      toast.success(`Imported ${n} ${n === 1 ? 'note' : 'notes'}`)
      setRows(null)
      onImported()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setBusy(true)
    try {
      const { rows: out, notes } = await exportCsv(deckId ?? null)
      const blob = new Blob([toCsv(out)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `recall-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      toast(`Exported ${notes} ${notes === 1 ? 'note' : 'notes'}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const nt = types.find((t) => t.id === typeId)
  const body = rows && mapping ? (mapping.hasHeader ? rows.slice(1) : rows) : []

  const ui = (
    <>
      <input
        ref={picker}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void read(file)
        }}
      />

      <Dialog open={!!rows} onOpenChange={(o) => !o && !busy && setRows(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import a spreadsheet</DialogTitle>
            <DialogDescription>
              {body.length} {body.length === 1 ? 'row' : 'rows'}, split on{' '}
              {delimiter === '\t' ? 'tabs' : delimiter === ';' ? 'semicolons' : 'commas'}.
              Check the columns below before importing.
            </DialogDescription>
          </DialogHeader>

          {mapping && nt && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="csv-type">Note type</Label>
                  <Select value={typeId} onValueChange={chooseType}>
                    <SelectTrigger id="csv-type" size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="csv-deck">Deck</Label>
                  <Select value={target} onValueChange={setTarget}>
                    <SelectTrigger id="csv-deck" size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {decks.map((d) => <SelectItem key={d.id} value={d.id}>{d.path}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={mapping.hasHeader}
                  onCheckedChange={(v) => setMapping({ ...mapping, hasHeader: v })}
                />
                The first row names the columns
              </label>

              <div className="space-y-1.5 border-t border-border pt-3">
                <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">
                  Columns
                </p>
                {(rows?.[0] ?? []).map((head, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Select
                      value={columnValue(mapping, i)}
                      onValueChange={(v) => setMapping(setColumn(mapping, i, v))}
                    >
                      <SelectTrigger size="sm" className="w-44 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Ignore this column</SelectItem>
                        {nt.fields.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                        <SelectItem value="__tags">Tags</SelectItem>
                        <SelectItem value="__deck">Deck</SelectItem>
                      </SelectContent>
                    </Select>
                    {/* The first body row, not the header: what the column will
                        actually put on a card is the useful thing to see. */}
                    <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                      {(mapping.hasHeader ? `${head} · ` : '') + (body[0]?.[i] ?? '')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRows(null)}>Cancel</Button>
            <Button
              disabled={busy || !target || !mapping?.fields.some(Boolean)}
              onClick={() => void run()}
            >
              Import {body.length} {body.length === 1 ? 'note' : 'notes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )

  return { busy, pick: () => picker.current?.click(), save: () => void save(), ui }
}

const columnValue = (m: CsvMapping, i: number): string =>
  m.tagColumn === i ? '__tags' : m.deckColumn === i ? '__deck' : m.fields[i] ?? NONE

/**
 * One column's role. Roles are exclusive across columns, so choosing a field
 * that another column already holds clears the other one — two columns feeding
 * one field would silently keep whichever came last.
 */
function setColumn(m: CsvMapping, i: number, value: string): CsvMapping {
  const fields = m.fields.map((f, j) => (j === i ? null : f === value ? null : f))
  return {
    ...m,
    fields: value === '__tags' || value === '__deck' || value === NONE
      ? fields
      : fields.map((f, j) => (j === i ? value : f)),
    tagColumn: value === '__tags' ? i : m.tagColumn === i ? null : m.tagColumn,
    deckColumn: value === '__deck' ? i : m.deckColumn === i ? null : m.deckColumn,
  }
}
