import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { CleanupListing, ExecutionType, RunStatus } from '../api/types'
import { formatBytes, timeAgo } from '../lib/format'

interface Props {
  onClose: () => void
}

// A unified table row covering both indexed runs and orphan directories.
interface Row {
  runId: string
  feature: string
  kind: ExecutionType | 'orphan'
  status: RunStatus | null
  startedAt: string | null
  folderBytes: number
  artifactBytes: number
  active: boolean
  isOrphan: boolean
}

const KIND_LABEL: Record<Row['kind'], string> = {
  run: 'TEST',
  verify: 'VERIFY',
  boot: 'BOOT',
  benchmark: 'BENCH',
  orphan: 'ORPHAN',
}

const STATUS_COLOR: Record<RunStatus, string> = {
  running: 'rgb(56, 189, 248)',
  healing: 'rgb(251, 191, 36)',
  queued: 'var(--text-secondary)',
  passed: 'rgb(52, 211, 153)',
  failed: 'rgb(251, 113, 133)',
  aborted: 'var(--text-muted)',
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const HUNDRED_MB = 100 * 1024 * 1024

type SortKey = 'runId' | 'kind' | 'status' | 'feature' | 'age' | 'folder' | 'artifacts'

// Numeric columns default to descending (biggest/newest first); text columns to ascending.
const NUMERIC_KEYS: ReadonlySet<SortKey> = new Set(['age', 'folder', 'artifacts'])

function sortValue(r: Row, key: SortKey): string | number {
  switch (key) {
    case 'runId': return r.runId
    case 'kind': return KIND_LABEL[r.kind]
    case 'status': return r.status ?? ''
    case 'feature': return r.feature
    case 'age': return r.startedAt ? Date.parse(r.startedAt) : 0
    case 'folder': return r.folderBytes
    case 'artifacts': return r.artifactBytes
  }
}

function listingToRows(listing: CleanupListing): Row[] {
  const runs: Row[] = listing.runs.map((r) => ({
    runId: r.runId,
    feature: r.feature,
    kind: r.executionType,
    status: r.status,
    startedAt: r.startedAt,
    folderBytes: r.folderBytes,
    artifactBytes: r.artifactBytes,
    active: r.active,
    isOrphan: false,
  }))
  const orphans: Row[] = listing.orphans.map((o) => ({
    runId: o.runId,
    feature: '—',
    kind: 'orphan' as const,
    status: null,
    startedAt: null,
    folderBytes: o.folderBytes,
    artifactBytes: 0,
    active: false,
    isOrphan: true,
  }))
  return [...runs, ...orphans].sort((a, b) => b.folderBytes - a.folderBytes)
}

function SortHeader({
  sortKey,
  label,
  align,
  sort,
  onSort,
}: {
  sortKey: SortKey
  label: string
  align?: 'right'
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (key: SortKey) => void
}) {
  const active = sort.key === sortKey
  return (
    <th
      className="cl-sort-th py-1 pr-3 select-none"
      style={{ textAlign: align ?? 'left', cursor: 'pointer' }}
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          color: active ? 'var(--text-secondary)' : undefined,
        }}
      >
        {label}
        <span style={{ fontSize: 9, opacity: active ? 1 : 0.3 }}>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '▾'}
        </span>
      </span>
    </th>
  )
}

export function LogCleanupPage({ onClose }: Props) {
  const [listing, setListing] = useState<CleanupListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ action: 'trim' | 'delete'; ids: string[]; bytes: number } | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'folder', dir: 'desc' })

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setListing(await api.cleanupRuns())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cleanup data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !confirm) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, confirm])

  const rows = useMemo(() => (listing ? listingToRows(listing) : []), [listing])
  const rowById = useMemo(() => new Map(rows.map((r) => [r.runId, r])), [rows])

  const sortedRows = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sort.key)
      const bv = sortValue(b, sort.key)
      if (av < bv) return -dir
      if (av > bv) return dir
      return 0
    })
  }, [rows, sort])

  const toggleSort = (key: SortKey): void => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: NUMERIC_KEYS.has(key) ? 'desc' : 'asc' },
    )
  }

  const toggle = (runId: string): void => {
    const row = rowById.get(runId)
    if (!row || row.active) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  const selectPreset = (predicate: (r: Row) => boolean): void => {
    setSelected(new Set(rows.filter((r) => !r.active && predicate(r)).map((r) => r.runId)))
  }

  const now = Date.now()
  const presets: Array<{ label: string; predicate: (r: Row) => boolean }> = [
    { label: 'Orphaned folders', predicate: (r) => r.isOrphan },
    { label: 'Aborted boots', predicate: (r) => r.kind === 'boot' && r.status === 'aborted' },
    { label: 'All aborted', predicate: (r) => r.status === 'aborted' },
    { label: 'All benchmark', predicate: (r) => r.kind === 'benchmark' },
    { label: 'Passed > 30 days', predicate: (r) => r.status === 'passed' && !!r.startedAt && now - Date.parse(r.startedAt) > THIRTY_DAYS_MS },
    { label: 'Folders > 100 MB', predicate: (r) => r.folderBytes > HUNDRED_MB },
  ]

  const selectedRows = rows.filter((r) => selected.has(r.runId))
  // Trim only reclaims artifact dirs, and orphans have none → exclude them.
  const trimBytes = selectedRows.filter((r) => !r.isOrphan).reduce((s, r) => s + r.artifactBytes, 0)
  const trimCount = selectedRows.filter((r) => !r.isOrphan && r.artifactBytes > 0).length
  const deleteBytes = selectedRows.reduce((s, r) => s + r.folderBytes, 0)

  const runAction = async (action: 'trim' | 'delete', ids: string[]): Promise<void> => {
    setBusy(true)
    setActionError(null)
    const results = await Promise.allSettled(
      ids.map((id) => (action === 'trim' ? api.trimRun(id) : api.deleteRun(id))),
    )
    const failures = results.filter((r) => r.status === 'rejected').length
    if (failures > 0) {
      setActionError(`${failures} of ${ids.length} ${action === 'trim' ? 'trims' : 'deletes'} failed (a run may have become active). Refreshed below.`)
    }
    setSelected(new Set())
    setBusy(false)
    await refresh()
  }

  const askTrim = (): void => {
    const ids = selectedRows.filter((r) => !r.isOrphan && r.artifactBytes > 0).map((r) => r.runId)
    if (ids.length > 0) setConfirm({ action: 'trim', ids, bytes: trimBytes })
  }
  const askDelete = (): void => {
    const ids = selectedRows.map((r) => r.runId)
    if (ids.length > 0) setConfirm({ action: 'delete', ids, bytes: deleteBytes })
  }

  const totals = listing?.totals

  return (
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-default)' }}>
        <h1 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Log Cleanup</h1>
        <button type="button" onClick={onClose} className="cl-button ml-auto px-3 py-1.5" aria-label="Close cleanup">
          Close ✕
        </button>
      </div>

      {/* Presets + totals */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2" style={{ borderColor: 'var(--border-default)' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Quick select:</span>
        {presets.map((p) => (
          <button key={p.label} type="button" onClick={() => selectPreset(p.predicate)} className="cl-button px-2 py-0.5" style={{ fontSize: 11 }}>
            {p.label}
          </button>
        ))}
        {selected.size > 0 && (
          <button type="button" onClick={() => setSelected(new Set())} className="cl-button px-2 py-0.5" style={{ fontSize: 11 }}>
            Clear selection
          </button>
        )}
        {totals && (
          <div className="ml-auto flex items-center gap-4" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            <span>Total on disk: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(totals.totalBytes)}</strong></span>
            <span>Reclaimable by trim: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(totals.reclaimableTrimBytes)}</strong></span>
            <span>By delete: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(totals.reclaimableDeleteBytes)}</strong></span>
            <button type="button" onClick={() => void refresh()} className="cl-button px-2 py-1" disabled={loading || busy}>Refresh</button>
          </div>
        )}
      </div>

      {actionError && (
        <div className="shrink-0 px-5 py-2" style={{ fontSize: 12, color: 'rgb(251, 113, 133)' }}>{actionError}</div>
      )}

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-2">
        {loading && <p style={{ color: 'var(--text-muted)' }}>Computing folder sizes…</p>}
        {error && <p style={{ color: 'rgb(251, 113, 133)' }}>{error}</p>}
        {!loading && !error && rows.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No runs on disk.</p>}
        {!loading && !error && rows.length > 0 && (
          <table className="w-full" style={{ fontSize: 12, color: 'var(--text-secondary)', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                <th className="py-1 pr-2" style={{ width: 28 }} />
                <SortHeader sortKey="runId" label="Run" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="kind" label="Kind" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="status" label="Status" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="feature" label="Feature" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="age" label="Age" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="folder" label="Folder" align="right" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="artifacts" label="Artifacts" align="right" sort={sort} onSort={toggleSort} />
                <th className="py-1 pr-1" style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => (
                <tr
                  key={r.runId}
                  style={{ borderTop: '1px solid var(--border-default)', opacity: r.active ? 0.5 : 1 }}
                  title={r.active ? 'Active run — abort it before cleaning up' : undefined}
                >
                  <td className="py-1 pr-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.runId)}
                      disabled={r.active}
                      onChange={() => toggle(r.runId)}
                      aria-label={`Select ${r.runId}`}
                    />
                  </td>
                  <td className="py-1 pr-3" style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-primary)' }}>{r.runId}</td>
                  <td className="py-1 pr-3">
                    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.4, color: 'var(--text-muted)' }}>{KIND_LABEL[r.kind]}</span>
                  </td>
                  <td className="py-1 pr-3">
                    {r.status
                      ? <span style={{ color: STATUS_COLOR[r.status] }}>{r.active ? `${r.status} ·active` : r.status}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>no manifest</span>}
                  </td>
                  <td className="py-1 pr-3">{r.feature}</td>
                  <td className="py-1 pr-3">{r.startedAt ? timeAgo(r.startedAt, now) : '—'}</td>
                  <td className="py-1 pr-3" style={{ textAlign: 'right', color: 'var(--text-primary)' }}>{formatBytes(r.folderBytes)}</td>
                  <td className="py-1 pr-3" style={{ textAlign: 'right' }}>{r.isOrphan ? '—' : formatBytes(r.artifactBytes)}</td>
                  <td className="py-1 pr-1" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {!r.isOrphan && r.artifactBytes > 0 && (
                      <button
                        type="button"
                        disabled={r.active || busy}
                        onClick={() => setConfirm({ action: 'trim', ids: [r.runId], bytes: r.artifactBytes })}
                        className="cl-button px-1.5 py-0.5"
                        style={{ fontSize: 11 }}
                      >Trim</button>
                    )}
                    <button
                      type="button"
                      disabled={r.active || busy}
                      onClick={() => setConfirm({ action: 'delete', ids: [r.runId], bytes: r.folderBytes })}
                      className="cl-button ml-1 px-1.5 py-0.5"
                      style={{ fontSize: 11, color: 'rgb(251, 113, 133)' }}
                    >Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Action bar */}
      {selected.size > 0 && (
        <div
          className="flex shrink-0 items-center gap-3 border-t px-5 py-3"
          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated, var(--bg-base))' }}
        >
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{selected.size}</strong> selected
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={askTrim}
              disabled={busy || trimBytes === 0}
              className="cl-button px-3 py-1"
              title={trimBytes === 0 ? 'No trimmable artifacts in selection' : undefined}
            >
              Trim artifacts {trimCount > 0 ? `(${trimCount} · ${formatBytes(trimBytes)})` : ''}
            </button>
            <button
              type="button"
              onClick={askDelete}
              disabled={busy}
              className="cl-button px-3 py-1"
              style={{ color: 'rgb(251, 113, 133)', borderColor: 'color-mix(in srgb, rgb(251,113,133) 45%, var(--border-default))' }}
            >
              Delete runs ({selected.size} · {formatBytes(deleteBytes)})
            </button>
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      {confirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-6" onClick={() => !busy && setConfirm(null)}>
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-lg border p-5"
            style={{ background: 'var(--bg-base)', borderColor: 'var(--border-default)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {confirm.action === 'trim' ? 'Trim artifacts' : 'Delete runs'}
            </h2>
            <p className="mt-2" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {confirm.action === 'trim'
                ? <>Delete the Playwright video/trace artifacts for <strong>{confirm.ids.length}</strong> run{confirm.ids.length === 1 ? '' : 's'}, reclaiming about <strong>{formatBytes(confirm.bytes)}</strong>. The runs stay in your history but lose video/trace playback.</>
                : <>Permanently delete <strong>{confirm.ids.length}</strong> run{confirm.ids.length === 1 ? '' : 's'} and their folders, reclaiming about <strong>{formatBytes(confirm.bytes)}</strong>. This cannot be undone.</>}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} disabled={busy} className="cl-button px-3 py-1">Cancel</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => { const c = confirm; setConfirm(null); void runAction(c.action, c.ids) }}
                className="cl-button px-3 py-1"
                style={confirm.action === 'delete' ? { color: 'rgb(251, 113, 133)' } : undefined}
              >
                {busy ? 'Working…' : confirm.action === 'trim' ? 'Trim' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
