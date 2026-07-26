// Pure utilities for the Journal tab. The server already filters and orders
// entries via the `?run=` / `?feature=` query, but we re-derive these client
// side too so the in-place "show all runs" toggle and the optimistic-after-
// delete refresh don't always need a round trip.

import type { JournalEntry } from '@/shared/api/types'

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

// Strict allowlist of journal fields shown in the structured view, mapped to
// their human-friendly labels. Anything not listed here is hidden from the
// UI — the raw markdown (reachable via "Show raw markdown") still carries
// every field, and the heal agent reads from that, so hiding here is a
// presentation-only filter. Strict mode prevents diff-block noise (`- metadata:`,
// `- channel:`, etc. matching the parser's field regex) from leaking through.
const JOURNAL_FIELD_DISPLAY: Record<string, string> = {
  hypothesis: 'hypothesis',
  'fix.description': 'fix description',
  signal: 'signal',
  outcome: 'outcome',
}

// Returns the human-facing label for a journal field key, or `null` if the
// field should be hidden from the UI.
export function formatJournalFieldKey(key: string): string | null {
  if (Object.prototype.hasOwnProperty.call(JOURNAL_FIELD_DISPLAY, key)) {
    return JOURNAL_FIELD_DISPLAY[key]
  }
  return null
}

// Convenience: filter + rename in one pass, preserving order.
export function presentJournalFields(fields: readonly ParsedField[]): ParsedField[] {
  const out: ParsedField[] = []
  for (const field of fields) {
    const label = formatJournalFieldKey(field.key)
    if (label === null) continue
    out.push({ key: label, value: field.value })
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
      return 'border-success/40 text-success bg-success/10'
    case 'partial':
      return 'border-warning/50 text-warning bg-warning/10'
    case 'no_change':
      return 'border-danger/40 text-danger bg-danger/10'
    case 'regression':
      return 'border-danger/50 text-danger bg-danger/15'
    case 'pending':
      return 'border-running/40 text-running bg-running/10'
    case 'unknown':
    default:
      return 'border-line-strong text-secondary bg-selected/60'
  }
}
