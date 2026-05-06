import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type { JournalEntry } from '../api/types'
import {
  classifyOutcome,
  newestFirst,
  outcomeBadgeClass,
  parseBodyFields,
} from '../lib/journal-utils'

interface Props {
  feature: string
  runId: string
}

export function JournalTab({ feature, runId }: Props) {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<JournalEntry | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    let cancelled = false
    api.listJournal({ feature, run: runId })
      .then((data) => {
        if (cancelled) return
        setEntries(newestFirst(data))
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [feature, runId])

  useEffect(() => {
    const cleanup = refresh()
    return cleanup
  }, [refresh])

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete || pendingDelete.iteration == null) return
    try {
      await api.deleteJournalEntry(pendingDelete.iteration, { run: runId })
      setPendingDelete(null)
      setDeleteError(null)
      refresh()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    }
  }, [pendingDelete, refresh, runId])

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-700 dark:text-rose-300">
            Failed to load journal: {error}
          </div>
        )}
        {!entries ? (
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading journal...</div>
        ) : entries.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No journal entries for this run.
          </div>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry, i) => (
              <EntryCard
                key={`${entry.iteration ?? 'x'}:${i}`}
                entry={entry}
                onDelete={() => { setPendingDelete(entry); setDeleteError(null) }}
              />
            ))}
          </ul>
        )}
      </div>
      {pendingDelete && (
        <ConfirmDeleteDialog
          entry={pendingDelete}
          error={deleteError}
          onCancel={() => { setPendingDelete(null); setDeleteError(null) }}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  )
}

function EntryCard({ entry, onDelete }: { entry: JournalEntry; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const fields = parseBodyFields(entry.body)
  const outcome = classifyOutcome(entry.outcome)
  return (
    <li className="rounded-lg p-3" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-elevated)' }}>
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            Iteration {entry.iteration ?? '?'}
          </span>
          {entry.timestamp && (
            <span className="text-[10px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{entry.timestamp}</span>
          )}
          <span className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${outcomeBadgeClass(outcome)}`}>
            {outcome}
          </span>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={entry.iteration == null}
          className="rounded-md border border-rose-500/30 px-2 py-0.5 text-[11px] text-rose-700 dark:text-rose-300 transition-colors duration-150 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Delete
        </button>
      </header>
      {fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-[120px_1fr] gap-x-2 gap-y-0.5 text-xs">
          {fields.map((f, idx) => (
            <FieldRow key={`${f.key}-${idx}`} field={f} />
          ))}
        </dl>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 text-[11px] transition-colors duration-150"
        style={{ color: 'var(--text-muted)' }}
      >
        {expanded ? 'Hide raw markdown' : 'Show raw markdown'}
      </button>
      {expanded && (
        <pre className="mt-1.5 overflow-x-auto rounded-md p-2 text-[11px]" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          {entry.body}
        </pre>
      )}
    </li>
  )
}

function FieldRow({ field }: { field: { key: string; value: string } }) {
  return (
    <>
      <dt style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{field.key}</dt>
      <dd className="break-all" style={{ color: 'var(--text-primary)' }}>{field.value}</dd>
    </>
  )
}

function ConfirmDeleteDialog({
  entry,
  error,
  onCancel,
  onConfirm,
}: {
  entry: JournalEntry
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-[420px] rounded-lg p-4 shadow-2xl" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}>
        <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Delete iteration {entry.iteration}?</h2>
        <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          This permanently removes it from <span style={{ fontFamily: 'var(--font-mono)' }}>logs/current/diagnosis-journal.md</span>.
        </p>
        {error && (
          <div className="mt-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2 text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 transition-colors duration-150"
            style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-rose-700 dark:text-rose-300 transition-colors duration-150 hover:bg-rose-500/20"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
