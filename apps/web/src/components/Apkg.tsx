import { useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { exportApkg } from '@/lib/anki/export'
import { importApkg, type ImportProgress, type ImportReport } from '@/lib/anki/import'

/**
 * Anki import and export.
 *
 * The import reports what it found rather than claiming success: how many notes
 * were *updated* rather than added is the number that tells you whether the
 * guid matching worked, and `[latex]` and unmeasurable occlusions are the two
 * things we knowingly do not carry perfectly (PHASES.md, Phase 4).
 */

const STAGE: Record<ImportProgress['stage'], string> = {
  reading: 'Opening the deck…',
  media: 'Storing images and audio…',
  notes: 'Importing notes and history…',
  done: 'Done',
}

export function ApkgButtons({ deckId, onImported }: { deckId?: string | null; onImported: () => void }) {
  const picker = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(file: File) {
    setBusy(true)
    setReport(null)
    setProgress({ stage: 'reading', done: 0, total: 0 })
    try {
      setReport(await importApkg(file, setProgress))
      onImported()
    } catch (e) {
      setProgress(null)
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setBusy(true)
    try {
      const out = await exportApkg(deckId)
      // A blob URL, revoked once the download has started: keeping it alive
      // pins the whole archive in memory, and a deck's archive is not small.
      const url = URL.createObjectURL(out.file)
      const a = document.createElement('a')
      a.href = url
      a.download = `recall-${new Date().toISOString().slice(0, 10)}.apkg`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      toast(`Exported ${out.notes} notes, ${out.cards} cards, ${out.reviews} reviews`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => picker.current?.click()}>
        <Upload /> Import
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void save()}>
        <Download /> Export
      </Button>
      <input
        ref={picker}
        type="file"
        accept=".apkg,.colpkg,application/zip"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void run(file)
        }}
      />

      <Dialog open={!!progress} onOpenChange={(o) => !o && !busy && setProgress(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{report ? 'Imported' : 'Importing'}</DialogTitle>
            <DialogDescription>
              {report
                ? 'Notes already here were matched by their Anki id and updated in place.'
                : STAGE[progress?.stage ?? 'reading']}
            </DialogDescription>
          </DialogHeader>

          {!report && <Progress value={pct} />}

          {report && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs">
              <Row label="notes added" value={report.notesAdded} />
              <Row label="notes updated" value={report.notesUpdated} />
              <Row label="note types" value={report.noteTypes} />
              <Row label="decks" value={report.decks} />
              <Row label="media files" value={report.media} />
              <Row label="reviews replayed" value={report.reviews} />
              {report.latexNotes > 0 && (
                <Row label="notes using [latex]" value={report.latexNotes} warn />
              )}
              {report.occlusionSkipped > 0 && (
                <Row label="occlusions unmeasured" value={report.occlusionSkipped} warn />
              )}
            </dl>
          )}

          {report && report.latexNotes > 0 && (
            <p className="text-xs text-muted-foreground">
              Maths renders with KaTeX. `[latex]` blocks that use full TeX packages
              will show their source instead.
            </p>
          )}

          <DialogFooter>
            <Button disabled={busy} onClick={() => setProgress(null)}>
              {busy ? 'Working…' : 'Close'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

const Row = ({ label, value, warn }: { label: string; value: number; warn?: boolean }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className={warn ? 'text-eosin' : ''}>{value}</dd>
  </>
)
