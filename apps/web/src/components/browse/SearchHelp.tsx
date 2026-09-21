import { useState } from 'react'
import { CircleQuestionMark } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

/**
 * What you can type in the search box.
 *
 * Search syntax that is only in the docs is folklore, and every one of these is
 * useless to somebody who does not know it exists. Each row appends itself to
 * the current search rather than replacing it, because the way people actually
 * arrive at a selection is one narrowing term at a time.
 *
 * There is no OR and there are no parentheses, deliberately — see the note at
 * the top of `core/search.ts`. Terms are ANDed, and `-` negates one.
 */
const SYNTAX: { group: string; rows: [string, string][] }[] = [
  {
    group: 'Where it lives',
    rows: [
      ['deck:Anatomy', 'that deck and everything under it'],
      ['tag:thorax', 'that tag and its children'],
      ['nid:<id>', 'every card of one note'],
    ],
  },
  {
    group: 'What state it is in',
    rows: [
      ['is:due', 'also new · learning · review · suspended · buried · flagged · marked · leech'],
      ['flag:1', 'flags 1 to 7'],
      ['due:7', 'due within a week · due:0 today · due:-1 already overdue'],
      ['lapses:>=3', 'failed at least three times'],
    ],
  },
  {
    group: 'What the scheduler thinks',
    rows: [
      ['prop:ivl>21', 'interval in days'],
      ['prop:s<10', 'stability — days until recall falls to 90%'],
      ['prop:d>8', 'difficulty, 1 to 10'],
      ['prop:r<0.8', 'predicted recall right now, 0 to 1'],
      ['prop:reps>20', 'also prop:lapses and prop:due'],
    ],
  },
  {
    group: 'What happened, and when',
    rows: [
      ['added:7', 'made in the last week'],
      ['rated:7', 'answered in the last week'],
      ['rated:7:1', 'failed in the last week'],
    ],
  },
  {
    group: 'Text',
    rows: [
      ['mitral', 'anywhere in the note'],
      ['"needs work"', 'quote anything with a space in it'],
      ['re:^mitral', 'a regular expression, case-insensitive'],
      ['-is:suspended', 'a minus excludes'],
    ],
  },
]

export function SearchHelp({ onInsert }: { onInsert: (term: string) => void }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        type="button" variant="ghost" size="icon-xs" aria-label="Search syntax"
        className="absolute top-1/2 right-7 -translate-y-1/2"
        onClick={() => setOpen(true)}
      >
        <CircleQuestionMark />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Search syntax</DialogTitle>
            <DialogDescription>
              Terms are combined with <em>and</em>. Click one to add it to what you have
              already typed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {SYNTAX.map(({ group, rows }) => (
              <div key={group} className="space-y-1.5">
                <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">{group}</p>
                {rows.map(([term, what]) => (
                  <button
                    key={term}
                    className="flex w-full items-baseline gap-3 rounded-xs px-1 py-0.5 text-left hover:bg-accent/40"
                    onClick={() => { onInsert(term); setOpen(false) }}
                  >
                    <code className="w-36 shrink-0 font-mono text-xs text-hematoxylin">{term}</code>
                    <span className="text-xs text-muted-foreground">{what}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
