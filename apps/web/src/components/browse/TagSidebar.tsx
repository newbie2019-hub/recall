import { Bookmark, Bug, Layers } from 'lucide-react'
import type { TagNode } from '@/db/queries/browse'

const LABEL = 'px-2 text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase'

/**
 * Tags as a folder tree: `anatomy::thorax::valves` nests three deep.
 *
 * A flat indented list, not a `Collapsible` sidebar — the same call the deck
 * tree made (UI.md §4.5). Collapse earns its keyboard handling, its expand
 * state and its persistence only at the depth where scrolling hurts, and a tag
 * list that deep is already a filing problem rather than a UI one.
 *
 * Clicking a parent selects everything beneath it, because the count beside it
 * already counts everything beneath it and a folder that returned fewer cards
 * than it advertises is rule 4 broken.
 */
export function TagSidebar({
  tags, active, onPick,
}: {
  tags: TagNode[]
  /** The `tag:` term currently in the search, if any. */
  active: string
  onPick: (tag: string | null) => void
}) {
  return (
    // Sticky, and scrollable in its own right: the card list runs to thousands
    // of rows and the filters are how you get out of them, so reaching row 400
    // must not mean scrolling back to row 1 to change the filter. `top-14`
    // clears the app bar, which is sticky too.
    <nav
      aria-label="Tags"
      className="sticky top-14 h-[calc(100dvh-4.5rem)] w-52 shrink-0 space-y-4 overflow-y-auto pt-4 pr-1 text-sm"
    >
      <div>
        <p className={LABEL}>Saved</p>
        <Row icon={<Layers />} label="All cards" active={!active} onClick={() => onPick(null)} />
        {/* Reserved tags, lifted out of the tree: `marked` is a bookmark the
            person sets by hand, `leech` is written by the scheduler and is
            read-only here (PHASES §6). Neither is a topic, so neither belongs
            beside anatomy::thorax. */}
        <Row icon={<Bookmark />} label="Marked" active={active === 'marked'} onClick={() => onPick('marked')} />
        <Row icon={<Bug />} label="Leeches" active={active === 'leech'} onClick={() => onPick('leech')} />
      </div>

      <div>
        <p className={LABEL}>Tags</p>
        {tags.length
          ? tags.map((t) => <Branch key={t.tag} node={t} active={active} onPick={onPick} />)
          : <p className="px-2 py-1 text-xs text-muted-foreground">No tags yet.</p>}
      </div>
    </nav>
  )
}

function Branch({
  node, active, onPick,
}: {
  node: TagNode
  active: string
  onPick: (tag: string) => void
}) {
  return (
    <>
      <Row
        label={node.label}
        count={node.cards}
        indent={node.depth}
        active={active === node.tag}
        onClick={() => onPick(node.tag)}
      />
      {node.children.map((c) => <Branch key={c.tag} node={c} active={active} onPick={onPick} />)}
    </>
  )
}

function Row({
  label, count, icon, indent = 0, active, onClick,
}: {
  label: string
  count?: number
  icon?: React.ReactNode
  indent?: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      style={{ paddingLeft: `${0.5 + indent * 0.75}rem` }}
      className={`flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-xs
        ${active ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50'}`}
    >
      {icon && <span className="[&_svg]:size-3 text-muted-foreground">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="font-mono text-[0.625rem] text-muted-foreground">{count}</span>
      )}
    </button>
  )
}
