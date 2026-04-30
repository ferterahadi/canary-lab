// Pure utilities for the Journal tab. The server already filters and orders
// entries via the `?run=` / `?feature=` query, but we re-derive these client
// side too so the in-place "show all runs" toggle and the optimistic-after-
// delete refresh don't always need a round trip.

import type { JournalEntry } from '../api/types'

// Newest first by iteration. Entries with a null iteration sink to the
// bottom (this is also what the server returns, but we re-sort to be safe
// after a client-side mutation).
export function newestFirst(entries: readonly JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) => {
    const ai = a.iteration ?? -Infinity
    const bi = b.iteration ?? -Infinity
    if (ai === bi) return 0
    return bi > ai ? 1 : -1
  })
}

export interface JournalFilter {
  feature?: string
  run?: string
}

export function filterEntries(
  entries: readonly JournalEntry[],
  filter: JournalFilter,
): JournalEntry[] {
  return entries.filter((e) => {
    if (filter.feature && e.feature !== filter.feature) return false
    if (filter.run && e.run !== filter.run) return false
    return true
  })
}

// Pull `- key: value` lines out of the entry body. The server-side parser
// only surfaces a handful of fields as structured columns; this digs further
// so the UI can render every field the user wrote without having to ship a
// schema for each one.
export interface ParsedField {
  key: string
  value: string
}

const FIELD_RE = /^\s*-\s+([\w.-]+):\s*(.*)$/

export function parseBodyFields(body: string): ParsedField[] {
  const out: ParsedField[] = []
  for (const line of body.split('\n')) {
    const m = FIELD_RE.exec(line)
    if (!m) continue
    out.push({ key: m[1], value: m[2].trim() })
  }
  return out
}

export type OutcomeBadge = 'pending' | 'all_passed' | 'partial' | 'no_change' | 'regression' | 'unknown'

export function classifyOutcome(outcome: string | null | undefined): OutcomeBadge {
  switch (outcome) {
    case 'pending':
    case 'all_passed':
    case 'partial':
    case 'no_change':
    case 'regression':
      return outcome
    default:
      return 'unknown'
  }
}

export function outcomeBadgeClass(outcome: OutcomeBadge): string {
  switch (outcome) {
    case 'all_passed':
      return 'border-emerald-500/40 text-emerald-700 bg-emerald-500/10 dark:text-emerald-300'
    case 'partial':
      return 'border-amber-500/50 text-amber-700 bg-amber-500/10 dark:text-amber-300'
    case 'no_change':
      return 'border-rose-500/40 text-rose-700 bg-rose-500/10 dark:text-rose-300'
    case 'regression':
      return 'border-rose-600/50 text-rose-800 bg-rose-600/15 dark:text-rose-200'
    case 'pending':
      return 'border-sky-500/40 text-sky-700 bg-sky-500/10 dark:text-sky-300'
    case 'unknown':
    default:
      return 'border-zinc-300 text-zinc-600 bg-zinc-200/40 dark:border-zinc-700 dark:text-zinc-400 dark:bg-zinc-800/40'
  }
}
