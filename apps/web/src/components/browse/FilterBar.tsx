import { useState } from 'react'
import { Search, X } from 'lucide-react'
import { CARD_STATES, formatSearch, setFacet, type Term, type TermKind } from '@recall/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchHelp } from './SearchHelp'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import type { DeckRow } from '@/db/repo'

/**
 * The facets and the search box are the same state.
 *
 * Every dropdown writes a term into the search string and reads its value back
 * out of it, so a filter built by clicking can be copied, pasted, shared and —
 * in Phase 7 — saved as a filtered deck's search. The alternative, a separate
 * filter object beside the text, needs a merge rule for every disagreement
 * between them and eventually grows a filter the text cannot express.
 */
export function FilterBar({
  search, terms, decks, onSearch,
}: {
  search: string
  terms: Term[]
  decks: DeckRow[]
  onSearch: (next: string) => void
}) {
  const [draft, setDraft] = useState(search)
  // The box is uncontrolled while it has focus — committing on every keystroke
  // would re-run the count query against a half-typed `tag:ana`.
  const [typing, setTyping] = useState(false)
  const shown = typing ? draft : search

  const facet = (kind: TermKind) => terms.find((t) => t.kind === kind && !t.neg)?.value ?? ''
  const set = (kind: TermKind, value: string) => {
    const next = formatSearch(setFacet(terms, kind, value === ALL ? null : value))
    setDraft(next)
    onSearch(next)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form
        className="relative min-w-64 flex-1"
        onSubmit={(e) => {
          e.preventDefault()
          setTyping(false)
          onSearch(draft)
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={shown}
          onChange={(e) => { setTyping(true); setDraft(e.target.value) }}
          onBlur={() => { setTyping(false); onSearch(draft) }}
          placeholder="deck:Anatomy tag:thorax is:due -flag:1"
          aria-label="Search every card"
          className="h-8 pr-14 pl-8 font-mono text-xs"
        />
        <SearchHelp onInsert={(term) => {
          const next = `${draft.trim()} ${term}`.trim()
          setDraft(next)
          setTyping(false)
          onSearch(next)
        }} />
        {shown && (
          <Button
            type="button" variant="ghost" size="icon-xs" aria-label="Clear search"
            className="absolute top-1/2 right-1 -translate-y-1/2"
            onClick={() => { setDraft(''); setTyping(false); onSearch('') }}
          >
            <X />
          </Button>
        )}
      </form>

      <Facet label="Deck" value={facet('deck')} onChange={(v) => set('deck', v)}
             options={decks.map((d) => ({ value: d.name, label: d.path }))} />
      <Facet label="State" value={facet('is')} onChange={(v) => set('is', v)}
             options={[...CARD_STATES, 'due', 'suspended', 'buried', 'flagged', 'marked', 'leech']
               .map((s) => ({ value: s, label: s }))} />
      <Facet label="Flag" value={facet('flag')} onChange={(v) => set('flag', v)}
             options={FLAG_NAMES.map((name, i) => ({ value: String(i + 1), label: name }))} />
      <Facet label="Due" value={facet('due')} onChange={(v) => set('due', v)}
             options={[
               { value: '0', label: 'today' },
               { value: '1', label: 'tomorrow' },
               { value: '7', label: 'next 7 days' },
               { value: '30', label: 'next 30 days' },
               { value: '-1', label: 'overdue' },
             ]} />
      <Facet label="Lapses" value={facet('lapses')} onChange={(v) => set('lapses', v)}
             options={['>=1', '>=3', '>=5', '>=8'].map((v) => ({ value: v, label: v.replace('>=', '≥ ') }))} />
    </div>
  )
}

/** Anki's flag names, in Anki's order — imported decks arrive carrying them. */
export const FLAG_NAMES = ['Red', 'Orange', 'Green', 'Blue', 'Pink', 'Turquoise', 'Purple']
/** Flag colour is reinforcement; the name is always shown beside it (UI.md). */
export const FLAG_COLORS = ['#C75F7D', '#D08A3E', '#4E8A5B', '#4A6FA5', '#C06BA8', '#3E9AA0', '#6B5BA8']

// Radix Select rejects the empty string as a value, so "any" needs a sentinel.
const ALL = '__any'

function Facet({
  label, value, options, onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  // Deck names are unique only among siblings, so two subdecks can share one.
  // Radix keys its items by value: a duplicate would select both at once.
  const unique = [...new Map(options.map((o) => [o.value, o])).values()]
  return (
    <Select value={value || ALL} onValueChange={onChange}>
      <SelectTrigger
        size="sm" aria-label={label}
        className={`h-8 w-auto gap-1.5 text-xs ${value ? 'border-primary text-primary' : 'text-muted-foreground'}`}
      >
        <span className="text-[0.625rem] tracking-[0.14em] uppercase">{label}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>any</SelectItem>
        {unique.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
