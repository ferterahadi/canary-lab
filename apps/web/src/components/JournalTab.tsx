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

// Journal tab — shows diagnosis-journal.md entries scoped to the selected
// run by default, with a checkbox to drop the run filter and see the full
// feature history (useful for spotting prior wrong hypotheses).
export function JournalTab({ feature, runId }: Props) {
  const [showAllRuns, setShowAllRuns] = useState(false)
  const [entries, setEntries] = useState<JournalEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<JournalEntry | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    let cancelled = false
    api.listJournal({
      feature,
      ...(showAllRuns ? {} : { run: runId }),
    })
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
  }, [feature, runId, showAllRuns])

  useEffect(() => {
    const cleanup = refresh()
    return cleanup
  }, [refresh])

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete || pendingDelete.iteration == null) return
    try {
      await api.deleteJournalEntry(pendingDelete.iteration)
      setPendingDelete(null)
      setDeleteError(null)
      refresh()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    }
  }, [pendingDelete, refresh])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-200 dark:border-zinc-800 px-4 py-2 text-xs">
        <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={showAllRuns}
            onChange={(e) => setShowAllRuns(e.target.checked)}
            className="h-3 w-3"
          />
          Show all runs (cross-run journal)
        </label>
        <span className="text-zinc-400 dark:text-zinc-600">·</span>
        <span className="text-zinc-500">Feature: {feature}</span>
        {!showAllRuns && (
          <>
            <span className="text-zinc-400 dark:text-zinc-600">·</span>
            <span className="font-mono text-zinc-500">Run: {runId}</span>
          </>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
            Failed to load journal: {error}
          </div>
        )}
        {!entries ? (
          <div className="text-sm text-zinc-500">Loading journal…</div>
        ) : entries.length === 0 ? (
          <div className="text-sm text-zinc-500">
            No journal entries{showAllRuns ? ` for feature ${feature}` : ' for this run'}.
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
    <li className="rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900/50 p-3">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
            Iteration {entry.iteration ?? '?'}
          </span>
          {entry.timestamp && (
            <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-600">{entry.timestamp}</span>
          )}
          <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${outcomeBadgeClass(outcome)}`}>
            {outcome}
          </span>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={entry.iteration == null}
          className="rounded border border-rose-500/30 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40"
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
        className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        {expanded ? 'Hide raw markdown' : 'Show raw markdown'}
      </button>
      {expanded && (
        <pre className="mt-1.5 overflow-x-auto rounded bg-white dark:bg-zinc-950 p-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
          {entry.body}
        </pre>
      )}
    </li>
  )
}

function FieldRow({ field }: { field: { key: string; value: string } }) {
  return (
    <>
      <dt className="font-mono text-zinc-500">{field.key}</dt>
      <dd className="break-all text-zinc-800 dark:text-zinc-200">{field.value}</dd>
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
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[420px] rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 shadow-xl">
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Delete iteration {entry.iteration}?</h2>
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          This permanently removes it from <span className="font-mono">logs/diagnosis-journal.md</span>.
        </p>
        {error && (
          <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2 text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-rose-200 hover:bg-rose-500/20"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
