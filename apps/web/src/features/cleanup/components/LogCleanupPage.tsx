import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/shared/api/client'
import type { CleanupListing } from '@/shared/api/types'
import { formatBytes, timeAgo } from '@/shared/lib/format'
import { CleanupEmptyState, FolderGlyph, QuickSelectMenu, SortHeader, SpinnerGlyph, WarnGlyph } from './CleanupTableParts'
import { PortifySection } from './PortifySection'
import { WorktreesSection } from './WorktreesSection'
import { CLEANUP_TABS, CleanupTab, FOURTEEN_DAYS_MS, HUNDRED_MB, KIND_LABEL, NUMERIC_KEYS, Row, SEVEN_DAYS_MS, STATUS_COLOR, SortKey, THIRTY_DAYS_MS, THREE_DAYS_MS, listingToRows, sortValue } from './cleanup-rows'

interface Props {
  onClose: () => void
  // Opens a run in the workspace (selects its feature + run, leaves cleanup).
  // Absent for orphans, which have no manifest/feature to open.
  onNavigateToRun?: (feature: string, runId: string) => void
  // Opens the workflow's feature at Flight → Parallel setup (leaves cleanup).
  onNavigateToPortify?: (feature: string) => void
}

export function LogCleanupPage({ onClose, onNavigateToRun, onNavigateToPortify }: Props) {
  const [listing, setListing] = useState<CleanupListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ action: 'trim' | 'delete'; ids: string[]; bytes: number } | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'folder', dir: 'desc' })
  const [view, setView] = useState<CleanupTab>('runs')

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
  const passedOlderThan = (ms: number) => (r: Row): boolean =>
    r.status === 'passed' && !!r.startedAt && now - Date.parse(r.startedAt) > ms
  const presets: Array<{ label: string; predicate: (r: Row) => boolean }> = [
    { label: 'Orphaned folders', predicate: (r) => r.isOrphan },
    { label: 'All failed', predicate: (r) => r.status === 'failed' },
    { label: 'All aborted', predicate: (r) => r.status === 'aborted' },
    { label: 'All benchmark', predicate: (r) => r.kind === 'benchmark' },
    { label: 'Passed > 3 days', predicate: passedOlderThan(THREE_DAYS_MS) },
    { label: 'Passed > 7 days', predicate: passedOlderThan(SEVEN_DAYS_MS) },
    { label: 'Passed > 14 days', predicate: passedOlderThan(FOURTEEN_DAYS_MS) },
    { label: 'Passed > 30 days', predicate: passedOlderThan(THIRTY_DAYS_MS) },
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
      {/* Header — the title doubles as a toggle between the two cleanup views.
          Shell-bar chrome + the segmented-control primitive so this overlay
          reads as the same tool as the workspace. */}
      <div className="cl-shell-bar flex shrink-0 items-center gap-3 px-4 py-2.5">
        <div className="cl-mode-toggle" style={{ margin: 0 }}>
          {CLEANUP_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setView(t.key)}
              aria-pressed={view === t.key}
              data-active={view === t.key}
              className="cl-mode-toggle-btn"
              style={{ paddingInline: 12, fontSize: 12 }}
            >
              {t.label}
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
        <div className="shrink-0 px-5 py-2" style={{ fontSize: 12, color: 'var(--danger)' }}>{actionError}</div>
      )}

      {/* Body */}
      {view === 'portify' ? (
        <PortifySection now={now} onNavigateToPortify={onNavigateToPortify} />
      ) : view === 'worktrees' ? (
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
              {/* Column headers speak the system's rubric voice (mono caps). */}
              <tr style={{ color: 'var(--text-muted)', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                <th className="py-1 pr-2" style={{ width: 28 }} />
                <SortHeader sortKey="runId" label="Run" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="kind" label="Kind" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="status" label="Status" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="feature" label="Suite" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="age" label="Age" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="folder" label="Folder" align="right" sort={sort} onSort={toggleSort} />
                <SortHeader sortKey="artifacts" label="Artifacts" align="right" sort={sort} onSort={toggleSort} />
                <th className="py-1 pl-3 pr-1" style={{ textAlign: 'right' }}>Actions</th>
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
                    style={{ accentColor: 'var(--accent)' }}
                      checked={selected.has(r.runId)}
                      disabled={r.active}
                      onChange={() => toggle(r.runId)}
                      aria-label={`Select ${r.runId}`}
                    />
                  </td>
                  <td className="py-1 pr-3" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                    {onNavigateToRun && !r.isOrphan
                      ? (
                        <button
                          type="button"
                          className="cl-run-link"
                          onClick={() => onNavigateToRun(r.feature, r.runId)}
                          title="Open this run in the workspace"
                        >
                          {r.runId}
                        </button>
                      )
                      : r.runId}
                  </td>
                  <td className="py-1 pr-3">
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{KIND_LABEL[r.kind]}</span>
                  </td>
                  <td className="py-1 pr-3">
                    {r.status
                      ? <span style={{ color: STATUS_COLOR[r.status] }}>{r.active ? `${r.status} ·active` : r.status}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>no manifest</span>}
                  </td>
                  <td className="py-1 pr-3">{r.feature}</td>
                  <td className="py-1 pr-3">{r.startedAt ? timeAgo(r.startedAt, now) : '—'}</td>
                  <td className="py-1 pr-3" style={{ textAlign: 'right', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{formatBytes(r.folderBytes)}</td>
                  <td className="py-1 pl-3 pr-3" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{r.isOrphan ? '—' : formatBytes(r.artifactBytes)}</td>
                  <td className="py-1 pl-3 pr-1" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
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
                      style={{ fontSize: 11, color: 'var(--danger)' }}
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
          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)' }}
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
              style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))' }}
            >
              Delete runs ({selected.size} · {formatBytes(deleteBytes)})
            </button>
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      {confirm && (
        <div className="cl-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-6" onClick={() => !busy && setConfirm(null)}>
          <div
            role="dialog"
            aria-modal="true"
            className="cl-modal w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
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
                style={confirm.action === 'delete' ? { color: 'var(--danger)' } : undefined}
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
