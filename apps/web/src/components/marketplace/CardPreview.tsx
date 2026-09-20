import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardFrame } from '@/components/CardFrame'
import { SpecimenTag } from '@/components/SpecimenTag'
import { Skeleton } from '@/components/ui/skeleton'
import { paintCard } from '@/lib/render'
import { toNoteType, type Listing, type Preview } from '@/lib/marketplace'

/**
 * A real sample, rendered by the renderer that will render it after cloning —
 * same template engine, same KaTeX pass, same frame. A screenshot or a
 * plain-text excerpt would be a promise the deck might not keep, and "the cards
 * look like what you were shown" is the differentiator.
 *
 * This is the most exposed screen in the app: the HTML and the CSS below were
 * written by a stranger nobody has vetted. Both go into `CardFrame`, whose
 * sandbox is `allow-same-origin` and nothing else — no `allow-scripts`, ever
 * (README rule 5). Nothing on this page may use `dangerouslySetInnerHTML`.
 *
 * It downloads nothing. The listing response carries the sample notes *and*
 * their note types, which is everything a card needs; fetching the version here
 * would mean anybody who opened a shared link pulled megabytes before deciding
 * whether they wanted the deck at all.
 */
const HAS_MEDIA = /media\/[0-9a-f]{64}|\[sound:/

export function CardPreview({ listing, preview }: { listing: Listing; preview: Preview }) {
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [painted, setPainted] = useState<{ front: string; back: string } | null>(null)

  const notes = preview.notes
  const note = notes.length ? notes[index % notes.length] : undefined
  const published = note ? preview.note_types.find((t) => t.id === note.note_type_id) : undefined
  const noteType = published ? toNoteType(published, listing.id) : null

  useEffect(() => {
    if (!note || !noteType) return
    let cancelled = false
    setPainted(null)
    void (async () => {
      // Ordinal 0: a sample shows the first card of each note. Rendering every
      // ordinal of a cloze with twelve deletions would be a tour, not a sample.
      const card = await paintCard(noteType, note.fields, 0, {
        tags: String(note.tags ?? '').split(' ').filter(Boolean),
      })
      if (!cancelled) setPainted({ front: card.front, back: card.back })
    })()
    return () => {
      cancelled = true
    }
    // Keyed on the note alone: `noteType` is rebuilt from `published` on every
    // render, so depending on it would repaint forever.
  }, [note])

  if (!notes.length) {
    return (
      <p className="text-sm text-muted-foreground">
        This deck was published without a preview. You can still clone it, but you
        will be looking at the cards for the first time afterwards.
      </p>
    )
  }

  const step = (by: number) => {
    setIndex((i) => (i + by + notes.length) % notes.length)
    setRevealed(false)
  }

  const missingMedia = note ? Object.values(note.fields).some((v) => HAS_MEDIA.test(v)) : false

  return (
    <div className="space-y-3">
      <SpecimenTag catalog={`${index + 1} / ${notes.length}`} path={note?.tags || undefined}>
        {!noteType ? (
          <p className="text-sm text-muted-foreground">
            This card's note type was not published with it, so it cannot be
            rendered honestly. It is left blank rather than guessed at.
          </p>
        ) : !painted ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="w-full">
            <CardFrame html={revealed ? painted.back : painted.front} css={noteType.css} />
          </div>
        )}
      </SpecimenTag>

      {missingMedia && (
        <p className="flex items-center gap-2 text-xs text-eosin">
          <ImageOff className="size-3.5 shrink-0" />
          This card refers to an image or audio file. Media does not travel with a
          published deck yet, so it is missing here and after cloning too.
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Previous card" onClick={() => step(-1)}>
            <ChevronLeft />
          </Button>
          <span className="font-mono text-xs text-muted-foreground">
            {index + 1} / {notes.length}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Next card" onClick={() => step(1)}>
            <ChevronRight />
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRevealed((r) => !r)}>
          {revealed ? 'Show question' : 'Show answer'}
        </Button>
      </div>
    </div>
  )
}
