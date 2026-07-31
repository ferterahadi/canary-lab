import { useCallback, useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { JournalEntry } from '@/shared/api/types'
import { EmptyGlyph, EmptyState } from '@/shared/ui/EmptyState'
import { RunPane } from './RunPane'
import {
  classifyOutcome,
  newestFirst,
  outcomeBadgeClass,
  parseBodyFields,
  presentJournalFields,
} from '../utils/journal-utils'

interface Props {
  feature: string
  runId: string
  refreshKey?: number
  /** Repair cycles this run went through. Zero means the journal is empty
   *  because nothing needed repairing — a different fact from "the agent ran
   *  and wrote nothing", and the empty state says which. */
  healCycles?: number
}

export function JournalTab({ feature, runId, refreshKey = 0, healCycles = 0 }: Props) {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((isCancelled: () => boolean = () => false) => {
    api.listJournal({ feature, run: runId })
      .then((data) => {
        if (isCancelled()) return
        setEntries(newestFirst(data))
        setError(null)
      })
      .catch((err: unknown) => {
        if (isCancelled()) return
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [feature, runId])

  useEffect(() => {
    let cancelled = false
    refresh(() => cancelled)
    return () => { cancelled = true }
  }, [refresh, refreshKey])

  useEffect(() => {
    if (!entries?.some((entry) => classifyOutcome(entry.outcome) === 'pending')) return
    const id = window.setInterval(() => refresh(), 2000)
    return () => window.clearInterval(id)
  }, [entries, refresh])

  return (
    <RunPane padded>
      {error && (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
          Failed to load journal: {error}
        </div>
      )}
      {!entries ? (
        <EmptyState icon={EmptyGlyph.journal} title="Loading journal…" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={healCycles > 0 ? EmptyGlyph.journal : EmptyGlyph.check}
          tone={healCycles > 0 ? 'neutral' : 'good'}
          title={healCycles > 0 ? 'No journal entries were written' : 'Nothing to repair'}
          body={
            healCycles > 0
              ? 'The repair agent ran on this run but left no journal entry. Its reasoning is still in the Heal agent tab.'
              : 'The journal records one entry per repair attempt — what the agent believed was broken, what it changed, and whether that fixed it. This run never needed one.'
          }
        />
      ) : (
        <ul className="space-y-3">
          {entries.map((entry, i) => (
            <EntryCard key={`${entry.iteration ?? 'x'}:${i}`} entry={entry} />
          ))}
        </ul>
      )}
    </RunPane>
  )
}

/**
 * One repair cycle.
 *
 * A cycle is a short story — what the agent thought was wrong, what it changed,
 * and whether that worked — so the hypothesis is the card's headline instead of
 * the first row of a four-row key/value table with the code's own field names
 * down the left. The remaining fields sit under it as a compact ledger in the
 * same mono-caps rubric the service cards use, and the raw markdown is a
 * disclosure that no longer pushes the card sideways when a field runs long.
 */
function EntryCard({ entry }: { entry: JournalEntry }) {
  const [expanded, setExpanded] = useState(false)
  const fields = presentJournalFields(parseBodyFields(entry.body))
  const headline = fields.find((f) => f.key === 'hypothesis')
  const rest = fields.filter((f) => f !== headline)
  const outcome = classifyOutcome(entry.outcome)
  return (
    <li className="cl-card p-3.5">
      <header className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] font-medium" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          Iteration {entry.iteration ?? '?'}
        </span>
        {entry.timestamp && (
          <span
            className="min-w-0 truncate text-[10px]"
            style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            title={entry.timestamp}
          >
            {formatLocalDateTime(entry.timestamp)}
          </span>
        )}
        <div className="min-w-2 flex-1" />
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${outcomeBadgeClass(outcome)}`}>
          {outcome}
        </span>
      </header>
      {headline && (
        <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
          {headline.value}
        </p>
      )}
      {rest.length > 0 && (
        <dl className="mt-2.5 grid grid-cols-[118px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {rest.map((f, idx) => (
            <FieldRow key={`${f.key}-${idx}`} field={f} />
          ))}
        </dl>
      )}
      <div className="mt-2.5 border-t pt-2" style={{ borderColor: 'var(--border-default)' }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors duration-150 -ml-1.5"
          style={{ color: 'var(--text-muted)' }}
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          Raw entry
          <span className="font-normal" style={{ opacity: 0.7 }}>as the agent wrote it</span>
        </button>
        {expanded && (
          // `whitespace-pre-wrap` + `break-all`, not a horizontal scroller: a
          // journal body carries hyphen-joined test names hundreds of characters
          // long, and a `<pre>` that scrolls sideways hides them off-card.
          <pre
            className="mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap break-all rounded-md p-2.5 text-[11px] leading-relaxed scrollbar-thin"
            style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
          >
            {entry.body}
          </pre>
        )}
      </div>
    </li>
  )
}

function formatLocalDateTime(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(time))
}

function FieldRow({ field }: { field: { key: string; value: string } }) {
  return (
    <>
      {/* Same rubric as every other field label in the run panes. */}
      <dt className="cl-rubric pt-0.5">{field.key}</dt>
      <dd className="min-w-0 break-words" style={{ color: 'var(--text-secondary)' }}>{field.value}</dd>
    </>
  )
}
