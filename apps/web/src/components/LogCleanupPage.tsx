import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '../api/client'
import type { CleanupListing, CleanupWorktree, ExecutionType, RunStatus } from '../api/types'
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
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
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

// "Quick select" presets collapsed into a single dropdown so the toolbar stays
// one tidy row instead of a wrapping pile of buttons. Closes on outside-click
// or Escape.
function QuickSelectMenu<T>({ presets, onSelect }: {
  presets: Array<{ label: string; predicate: (r: T) => boolean }>
  onSelect: (predicate: (r: T) => boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="cl-button px-2 py-0.5"
        style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5 }}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Quick select <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20, minWidth: 190,
            background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)', boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
            padding: 4, display: 'flex', flexDirection: 'column',
          }}
        >
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              role="menuitem"
              onClick={() => { onSelect(p.predicate); setOpen(false) }}
              className="cl-menu-item"
              style={{ textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 12, padding: '6px 9px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
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
  const [view, setView] = useState<'runs' | 'worktrees'>('runs')

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
      {/* Header — the title doubles as a toggle between the two cleanup views. */}
      <div className="flex shrink-0 items-center gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-default)' }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {(['runs', 'worktrees'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              style={{
                background: view === v ? 'var(--bg-selected)' : 'var(--bg-surface)',
                color: view === v ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: 'none',
                borderRight: v === 'runs' ? '1px solid var(--border-default)' : 'none',
                padding: '6px 14px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {v === 'runs' ? 'Log Cleanup' : 'Worktrees'}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="cl-button ml-auto px-3 py-1.5" aria-label="Close cleanup">
          Close ✕
        </button>
      </div>

      {/* Presets + totals (runs view only) */}
      {view === 'runs' && (
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2" style={{ borderColor: 'var(--border-default)' }}>
        <QuickSelectMenu presets={presets} onSelect={selectPreset} />
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
      )}

      {view === 'runs' && actionError && (
        <div className="shrink-0 px-5 py-2" style={{ fontSize: 12, color: 'rgb(251, 113, 133)' }}>{actionError}</div>
      )}

      {/* Body */}
      {view === 'worktrees' ? (
        <WorktreesSection now={now} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-5 py-2">
        {loading && <CleanupEmptyState icon={<SpinnerGlyph />} title="Computing folder sizes…" />}
        {!loading && error && (
          <CleanupEmptyState icon={<WarnGlyph />} title="Couldn't load cleanup data" hint={error} action={{ label: 'Retry', onClick: () => void refresh() }} />
        )}
        {!loading && !error && rows.length === 0 && (
          <CleanupEmptyState icon={<FolderGlyph />} title="No runs on disk" hint="Test, verify, boot and benchmark runs show up here with their disk usage once you record them." />
        )}
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
      )}

      {/* Action bar (runs view only) */}
      {view === 'runs' && selected.size > 0 && (
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

// Self-contained worktree inventory: every git worktree canary-lab created
// under the logs dir (frozen-bug snapshots, run isolation, benchmark arms, and
// stale orphans), with "Open" (in editor) and "Remove" (git worktree remove).
// Owns its own fetch so it can refresh independently of the runs table.
function WorktreesSection({ now }: { now: number }) {
  const [worktrees, setWorktrees] = useState<CleanupWorktree[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const wts = (await api.cleanupWorktrees()).worktrees
      setWorktrees(wts)
      // Drop selections for worktrees that no longer exist (e.g. removed
      // elsewhere or pruned), so the bulk count never references stale paths.
      setSelected((prev) => new Set([...prev].filter((p) => wts.some((w) => w.path === p))))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load worktrees')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const open = async (wt: CleanupWorktree): Promise<void> => {
    try {
      const r = await api.openWorktreePath(wt.path)
      if (!r.opened) window.prompt('Could not launch your editor — copy this path:', wt.path)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }
  const remove = async (wt: CleanupWorktree): Promise<void> => {
    if (!window.confirm(`Remove this worktree?\n\n${wt.path}\n\nRuns "git worktree remove" and frees ~${formatBytes(wt.bytes)}.`)) return
    setBusyPath(wt.path)
    try {
      await api.removeWorktree(wt.path)
      await load()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyPath(null)
    }
  }

  const sorted = (worktrees ?? []).slice().sort((a, b) => b.bytes - a.bytes)
  const total = sorted.reduce((s, w) => s + w.bytes, 0)

  // Selection mirrors the runs view: active worktrees can't be removed, so they
  // can't be ticked. Quick-select presets bulk-tick non-active matches.
  const toggle = (path: string): void => {
    const wt = sorted.find((w) => w.path === path)
    if (!wt || wt.active) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const selectPreset = (predicate: (w: CleanupWorktree) => boolean): void => {
    setSelected(new Set(sorted.filter((w) => !w.active && predicate(w)).map((w) => w.path)))
  }
  const presets: Array<{ label: string; predicate: (w: CleanupWorktree) => boolean }> = [
    { label: 'Orphans', predicate: (w) => w.ownerKind === 'unknown' },
    { label: 'Missing dirs (prunable)', predicate: (w) => !w.exists },
    { label: 'Benchmark arms', predicate: (w) => w.ownerKind === 'benchmark' },
    { label: 'Older than 7 days', predicate: (w) => w.ageMs != null && w.ageMs > SEVEN_DAYS_MS },
  ]
  const selectedTargets = sorted.filter((w) => selected.has(w.path) && !w.active)
  const selectedBytes = selectedTargets.reduce((s, w) => s + w.bytes, 0)

  // Confirmation lives in a modal (mirrors the runs delete flow) rather than a
  // window.confirm, so the bulk-remove experience matches Log Cleanup exactly.
  const doRemoveSelected = async (): Promise<void> => {
    if (selectedTargets.length === 0) return
    const n = selectedTargets.length
    setConfirmOpen(false)
    setBulkBusy(true)
    const results = await Promise.allSettled(selectedTargets.map((w) => api.removeWorktree(w.path)))
    const failures = results.filter((r) => r.status === 'rejected').length
    setSelected(new Set())
    setBulkBusy(false)
    await load()
    if (failures > 0) window.alert(`${failures} of ${n} removals failed (a worktree may have become active).`)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar mirrors the runs view: quick-select + clear on the left, totals
          + Refresh as a right-aligned cluster (same styling as the Log Cleanup
          totals bar). Bulk delete lives in the bottom action bar below. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2" style={{ borderColor: 'var(--border-default)' }}>
        {sorted.length > 0 && <QuickSelectMenu presets={presets} onSelect={selectPreset} />}
        {selected.size > 0 && (
          <button type="button" onClick={() => setSelected(new Set())} className="cl-button px-2 py-0.5" style={{ fontSize: 11 }} disabled={bulkBusy}>
            Clear selection
          </button>
        )}
        <div className="ml-auto flex items-center gap-4" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {sorted.length > 0 && (
            <>
              <span>Worktrees: <strong style={{ color: 'var(--text-primary)' }}>{sorted.length}</strong></span>
              <span>Total on disk: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(total)}</strong></span>
            </>
          )}
          <button type="button" onClick={() => void load()} className="cl-button px-2 py-1" disabled={loading || bulkBusy}>Refresh</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-2">
      {loading && <CleanupEmptyState icon={<SpinnerGlyph />} title="Scanning worktrees…" />}
      {!loading && err && (
        <CleanupEmptyState icon={<WarnGlyph />} title="Couldn't load worktrees" hint={err} action={{ label: 'Retry', onClick: () => void load() }} />
      )}
      {!loading && !err && sorted.length === 0 && (
        <CleanupEmptyState
          icon={<WorktreeGlyph />}
          title="No worktrees on disk"
          hint="Worktrees appear here when you open a frozen bug to inspect, isolate a run, or a benchmark spins up its arms — remove them here to reclaim disk."
        />
      )}
      {!loading && !err && sorted.length > 0 && (
        <table className="w-full" style={{ fontSize: 12, color: 'var(--text-secondary)', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
              <th className="py-1 pr-2" style={{ width: 28 }} />
              <th className="py-1 pr-3">Owner</th>
              <th className="py-1 pr-3">Ref</th>
              <th className="py-1 pr-3">Path</th>
              <th className="py-1 pr-3" style={{ textAlign: 'right' }}>Size</th>
              <th className="py-1 pr-3">Age</th>
              <th className="py-1 pr-1" style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((wt) => (
              <tr
                key={wt.path}
                style={{ borderTop: '1px solid var(--border-default)', opacity: !wt.exists ? 0.5 : wt.active ? 0.7 : 1 }}
                title={wt.active ? 'Active run — abort it before removing' : (!wt.exists ? 'Directory missing — git still registers it (prunable)' : undefined)}
              >
                <td className="py-1 pr-2">
                  <input
                    type="checkbox"
                    checked={selected.has(wt.path)}
                    disabled={wt.active || bulkBusy}
                    onChange={() => toggle(wt.path)}
                    aria-label={`Select ${wt.ownerId ?? wt.ref}`}
                  />
                </td>
                <td className="py-1 pr-3">
                  <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.4, color: 'var(--text-muted)' }}>
                    {wt.ownerKind === 'benchmark' ? 'BENCH' : wt.ownerKind === 'run' ? 'RUN' : 'ORPHAN'}
                  </span>
                  {wt.ownerId && <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-primary)' }}>{wt.ownerId}</span>}
                  {wt.slot && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>{wt.slot}</span>}
                  {wt.active && <span style={{ marginLeft: 6, color: 'rgb(56, 189, 248)' }}>·active</span>}
                </td>
                <td className="py-1 pr-3" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{wt.ref}</td>
                <td className="py-1 pr-3" style={{ color: 'var(--text-muted)', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={wt.path}>{wt.path}</td>
                <td className="py-1 pr-3" style={{ textAlign: 'right', color: 'var(--text-primary)' }}>{wt.exists ? formatBytes(wt.bytes) : '—'}</td>
                <td className="py-1 pr-3">{wt.ageMs != null ? timeAgo(new Date(now - wt.ageMs).toISOString(), now) : '—'}</td>
                <td className="py-1 pr-1" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {wt.exists && (
                    <button type="button" onClick={() => void open(wt)} disabled={busyPath === wt.path || bulkBusy} className="cl-button px-1.5 py-0.5" style={{ fontSize: 11 }}>Open</button>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(wt)}
                    disabled={wt.active || busyPath === wt.path || bulkBusy}
                    className="cl-button ml-1 px-1.5 py-0.5"
                    style={{ fontSize: 11, color: 'rgb(251, 113, 133)' }}
                  >
                    {busyPath === wt.path ? '…' : 'Remove'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </div>

      {/* Bottom action bar — identical to the runs view's. */}
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
              onClick={() => setConfirmOpen(true)}
              disabled={bulkBusy || selectedTargets.length === 0}
              className="cl-button px-3 py-1"
              style={{ color: 'rgb(251, 113, 133)', borderColor: 'color-mix(in srgb, rgb(251,113,133) 45%, var(--border-default))' }}
            >
              {bulkBusy ? 'Removing…' : `Remove worktrees (${selectedTargets.length} · ${formatBytes(selectedBytes)})`}
            </button>
          </div>
        </div>
      )}

      {/* Confirm dialog — mirrors the runs delete confirm. */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-6" onClick={() => !bulkBusy && setConfirmOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-lg border p-5"
            style={{ background: 'var(--bg-base)', borderColor: 'var(--border-default)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Remove worktrees</h2>
            <p className="mt-2" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Run <strong>git worktree remove</strong> on <strong>{selectedTargets.length}</strong> worktree{selectedTargets.length === 1 ? '' : 's'}, reclaiming about <strong>{formatBytes(selectedBytes)}</strong>. The source repos are untouched — this only removes the checked-out copies under logs.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} disabled={bulkBusy} className="cl-button px-3 py-1">Cancel</button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => void doRemoveSelected()}
                className="cl-button px-3 py-1"
                style={{ color: 'rgb(251, 113, 133)' }}
              >
                {bulkBusy ? 'Working…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Centered empty / loading / error state, sized to roughly center in the body
// like the Log Cleanup layout. Reused across both views for a consistent feel.
function CleanupEmptyState({ icon, title, hint, action }: {
  icon: ReactNode
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-6 text-center"
      style={{ minHeight: '55vh', animation: 'fm-fade-up 220ms ease-out both' }}
    >
      <span style={{ color: 'var(--text-muted)', opacity: 0.5 }}>{icon}</span>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>{title}</div>
      {hint && (
        <div style={{ maxWidth: 380, fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-muted)' }}>{hint}</div>
      )}
      {action && (
        <button type="button" onClick={action.onClick} className="cl-button mt-1 px-3 py-1" style={{ fontSize: 12 }}>
          {action.label}
        </button>
      )}
    </div>
  )
}

// git-worktree glyph: a branch forking off a trunk (two nodes + a merge point).
function WorktreeGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 9.2c0 4-4 3.8-7 5.4" />
    </svg>
  )
}

function FolderGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

function WarnGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

// Slow-spinning ring for loading states (reuses the canary-pulse cadence feel).
function SpinnerGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ animation: 'cl-spin 0.9s linear infinite' }}>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  )
}
