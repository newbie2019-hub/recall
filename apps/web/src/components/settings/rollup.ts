/**
 * Subtree arithmetic for the storage list. No imports, so the check next to it
 * runs under plain `node --test`.
 */
export interface SizeNode {
  id: string
  parent_id: string | null
  notes: number
  cards: number
  bytes: number
}

export interface Totals {
  notes: number
  cards: number
  bytes: number
}

/**
 * What each deck costs including its children.
 *
 * Decks are a `parent_id` tree (rule 3) and a parent that showed only the notes
 * filed directly on it would read as 0 for every deck anybody actually uses as
 * a folder — and then the switch beside it would claim to keep nothing offline.
 *
 * The `seen` guard is not defensive decoration: a move that made a deck its own
 * ancestor would otherwise hang the settings screen rather than show a wrong
 * number, and a hang is the harder bug to report.
 */
export function rollUp(rows: SizeNode[]): Map<string, Totals> {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const totals = new Map<string, Totals>(rows.map((r) => [r.id, { notes: 0, cards: 0, bytes: 0 }]))

  for (const row of rows) {
    const seen = new Set<string>()
    let node: SizeNode | undefined = row
    while (node && !seen.has(node.id)) {
      seen.add(node.id)
      const t = totals.get(node.id)
      if (t) {
        t.notes += row.notes
        t.cards += row.cards
        t.bytes += row.bytes
      }
      node = node.parent_id ? byId.get(node.parent_id) : undefined
    }
  }
  return totals
}

/** Bytes as a person reads them. Binary units, because that is what quotas are in. */
export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, n)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit > 0 && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
