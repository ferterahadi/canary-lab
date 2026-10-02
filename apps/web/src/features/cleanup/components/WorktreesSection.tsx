import { useCleanupInventory } from '../state/use-cleanup-inventory'
import { useCleanupSelection } from '../state/use-cleanup-selection'
import { useCleanupAction } from '../state/use-cleanup-action'
import { useState } from 'react'
import * as cleanupApi from '@/shared/api/cleanup'
import type { CleanupWorktree } from '@/shared/api/types-cleanup'
import { formatBytes, timeAgo } from '@/shared/lib/format'
import { ConfirmModal } from '@/shared/ui/Overlays'
import { CleanupActionBar, CleanupToolbar, CleanupRefreshError, CleanupEmptyState, SpinnerGlyph, WarnGlyph, WorktreeGlyph } from './CleanupTableParts'
import { SEVEN_DAYS_MS, WORKTREE_OWNER_LABEL } from './cleanup-rows'

// Self-contained worktree inventory: every git worktree canary-lab created
// under the logs dir (frozen-bug snapshots, run isolation, benchmark arms, and
// stale orphans), with "Open" (in editor) and "Remove" (git worktree remove).
// Owns its own fetch so it can refresh independently of the runs table.
export function WorktreesSection({ now }: { now: number }) {
  const inventory = useCleanupInventory('worktrees', cleanupApi.cleanupWorktrees)
  const worktrees = inventory.value?.worktrees ?? []
  const { initialLoading: loading, error: err, refresh: load } = inventory
  const { selected, clear, toggle, selectPreset } = useCleanupSelection(worktrees, (row) => row.path, (row) => !row.active, inventory.confirmed)
  const { busy: bulkBusy, error: actionError, setError: setActionError, execute } = useCleanupAction(load)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // A single worktree awaiting confirmation. This was a `window.confirm`, which
  // is the one dialog in the app the app does not draw: an OS chrome sheet,
  // untokened, unthemed, and unstyled by anything here.
  const [confirmOne, setConfirmOne] = useState<CleanupWorktree | null>(null)
  const open = async (wt: CleanupWorktree): Promise<void> => {
    setActionError(null)
    try {
      const r = await cleanupApi.openWorktreePath(wt.path)
      // The path stays selectable in the error strip, which is what the
      // `window.prompt` this replaced was really being used for.
      if (!r.opened) setActionError(`Could not launch your editor. The worktree is at ${wt.path}`)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }
  const remove = async (wt: CleanupWorktree): Promise<void> => {
    setConfirmOne(null)
    const current = worktrees.find((row) => row.path === wt.path && !row.active)
    if (!current) return
    setBusyPath(current.path)
    await execute([current], (row) => cleanupApi.removeWorktree(row.path), () => {},
      () => 'Could not remove the worktree. It may have become active. Refreshed below.')
    setBusyPath(null)
  }

  const sorted = worktrees.slice().sort((a, b) => b.bytes - a.bytes)
  const total = sorted.reduce((s, w) => s + w.bytes, 0)

  const presets: Array<{ label: string; predicate: (w: CleanupWorktree) => boolean }> = [
    { label: 'Orphans', predicate: (w) => w.ownerKind === 'unknown' },
    { label: 'Missing dirs (prunable)', predicate: (w) => !w.exists },
    { label: 'Benchmark arms', predicate: (w) => w.ownerKind === 'benchmark' },
    { label: 'Portify worktrees', predicate: (w) => w.ownerKind === 'portify' },
    { label: 'Older than 7 days', predicate: (w) => w.ageMs != null && w.ageMs > SEVEN_DAYS_MS },
  ]
  const selectedTargets = sorted.filter((w) => selected.has(w.path) && !w.active)
  const selectedBytes = selectedTargets.reduce((s, w) => s + w.bytes, 0)

  // Both confirmations are the shared `ConfirmModal`, so bulk and single
  // removal read as the same decision at the same weight.
  const doRemoveSelected = async (): Promise<void> => {
    if (selectedTargets.length === 0) return
    const n = selectedTargets.length
    setConfirmOpen(false)
    await execute(selectedTargets, (row) => cleanupApi.removeWorktree(row.path), clear,
      (failures) => `${failures} of ${n} removals failed (a worktree may have become active). Refreshed below.`)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CleanupToolbar presets={sorted.length > 0 ? presets : []} onSelect={selectPreset} selectedCount={selected.size} onClear={clear} busy={bulkBusy} loading={inventory.loading} onRefresh={load}>
        {sorted.length > 0 && <>
          <span>Worktrees: <strong style={{ color: 'var(--text-primary)' }}>{sorted.length}</strong></span>
          <span>Total on disk: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(total)}</strong></span>
        </>}
      </CleanupToolbar>
      {inventory.value !== null && err && <CleanupRefreshError error={err} />}
      {actionError && (
        <div role="alert" data-testid="worktrees-action-error" className="shrink-0 px-5 py-2" style={{ fontSize: 12, color: 'var(--danger)' }}>{actionError}</div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-2">
      {loading && <CleanupEmptyState icon={<SpinnerGlyph />} title="Scanning worktrees…" />}
      {!loading && err && inventory.value === null && (
        <CleanupEmptyState icon={<WarnGlyph />} title="Couldn't load worktrees" hint={err} action={{ label: 'Retry', onClick: () => void load() }} />
      )}
      {!loading && !err && sorted.length === 0 && (
        <CleanupEmptyState
          icon={<WorktreeGlyph />}
          title="No worktrees on disk"
          hint="Worktrees appear here when you open a frozen bug to inspect, isolate a run, or a benchmark spins up its arms — remove them here to reclaim disk."
        />
      )}
      {sorted.length > 0 && (
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
                    onClick={() => setConfirmOne(wt)}
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

      {selected.size > 0 && (
        <CleanupActionBar selectedCount={selected.size}>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={bulkBusy || selectedTargets.length === 0}
              className="cl-button cl-button-danger px-3 py-1"
            >
              {bulkBusy ? 'Removing…' : `Remove worktrees (${selectedTargets.length} · ${formatBytes(selectedBytes)})`}
            </button>
          </CleanupActionBar>
      )}

      <ConfirmModal
        open={confirmOpen}
        title="Remove worktrees"
        variant="danger"
        busy={bulkBusy}
        confirmLabel="Remove"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void doRemoveSelected()}
        message={<>Run <strong>git worktree remove</strong> on <strong>{selectedTargets.length}</strong> worktree{selectedTargets.length === 1 ? '' : 's'}, reclaiming about <strong>{formatBytes(selectedBytes)}</strong>. The source repos are untouched — this only removes the checked-out copies under logs.</>}
      />

      <ConfirmModal
        open={confirmOne !== null}
        title="Remove worktree"
        variant="danger"
        busy={busyPath !== null}
        confirmLabel="Remove"
        onCancel={() => setConfirmOne(null)}
        onConfirm={() => { if (confirmOne) void remove(confirmOne) }}
        message={<>Run <strong>git worktree remove</strong> on <code style={{ fontFamily: 'var(--font-mono)' }}>{confirmOne?.path}</code>, reclaiming about <strong>{formatBytes(confirmOne?.bytes ?? 0)}</strong>. The source repo is untouched — this only removes the checked-out copy under logs.</>}
      />
    </div>
  )
}
