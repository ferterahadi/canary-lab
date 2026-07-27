import { useCallback, useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { CleanupWorktree } from '@/shared/api/types'
import { formatBytes, timeAgo } from '@/shared/lib/format'
import { CleanupEmptyState, QuickSelectMenu, SpinnerGlyph, WarnGlyph, WorktreeGlyph } from './CleanupTableParts'
import { SEVEN_DAYS_MS, WORKTREE_OWNER_LABEL } from './cleanup-rows'

// Self-contained worktree inventory: every git worktree canary-lab created
// under the logs dir (frozen-bug snapshots, run isolation, benchmark arms, and
// stale orphans), with "Open" (in editor) and "Remove" (git worktree remove).
// Owns its own fetch so it can refresh independently of the runs table.
export function WorktreesSection({ now }: { now: number }) {
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
    { label: 'Portify worktrees', predicate: (w) => w.ownerKind === 'portify' },
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
            <tr style={{ color: 'var(--text-muted)', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              <th className="py-1 pr-2" style={{ width: 28 }} />
              <th className="py-1 pr-3">Owner</th>
              <th className="py-1 pr-3">Ref</th>
              <th className="py-1 pr-3">Path</th>
              {/* Age then "Folder" — same column name AND order as the runs and
                  portify tabs, so the three tables read as one table family. */}
              <th className="py-1 pr-3">Age</th>
              <th className="py-1 pr-3" style={{ textAlign: 'right' }}>Folder</th>
              <th className="py-1 pl-3 pr-1" style={{ textAlign: 'right' }}>Actions</th>
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
                    style={{ accentColor: 'var(--accent)' }}
                    checked={selected.has(wt.path)}
                    disabled={wt.active || bulkBusy}
                    onChange={() => toggle(wt.path)}
                    aria-label={`Select ${wt.ownerId ?? wt.ref}`}
                  />
                </td>
                <td className="py-1 pr-3">
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                    {WORKTREE_OWNER_LABEL[wt.ownerKind]}
                  </span>
                  {wt.ownerId && <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{wt.ownerId}</span>}
                  {wt.slot && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>{wt.slot}</span>}
                  {wt.active && <span style={{ marginLeft: 6, color: 'var(--running)' }}>·active</span>}
                </td>
                <td className="py-1 pr-3" style={{ fontFamily: 'var(--font-mono)' }}>{wt.ref}</td>
                <td className="py-1 pr-3" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={wt.path}>{wt.path}</td>
                <td className="py-1 pr-3">{wt.ageMs != null ? timeAgo(new Date(now - wt.ageMs).toISOString(), now) : '—'}</td>
                <td className="py-1 pr-3" style={{ textAlign: 'right', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{wt.exists ? formatBytes(wt.bytes) : '—'}</td>
                <td className="py-1 pl-3 pr-1" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {wt.exists && (
                    <button type="button" onClick={() => void open(wt)} disabled={busyPath === wt.path || bulkBusy} className="cl-button px-1.5 py-0.5" style={{ fontSize: 11 }}>Open</button>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(wt)}
                    disabled={wt.active || busyPath === wt.path || bulkBusy}
                    className="cl-button ml-1 px-1.5 py-0.5"
                    style={{ fontSize: 11, color: 'var(--danger)' }}
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
          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)' }}
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
              style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))' }}
            >
              {bulkBusy ? 'Removing…' : `Remove worktrees (${selectedTargets.length} · ${formatBytes(selectedBytes)})`}
            </button>
          </div>
        </div>
      )}

      {/* Confirm dialog — mirrors the runs delete confirm. */}
      {confirmOpen && (
        <div className="cl-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-6" onClick={() => !bulkBusy && setConfirmOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            className="cl-modal w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Remove worktrees</h2>
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
                style={{ color: 'var(--danger)' }}
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
