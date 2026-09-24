import { useCallback, useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { PortifyCleanupEntry } from '@/shared/api/types'
import { formatBytes, timeAgo } from '@/shared/lib/format'
import { ConfirmModal } from '@/shared/ui/atoms'
import { CleanupEmptyState, FolderGlyph, QuickSelectMenu, SpinnerGlyph, WarnGlyph } from './CleanupTableParts'
import { PORTIFY_STATUS_COLOR, SEVEN_DAYS_MS } from './cleanup-rows'

// Self-contained port-ification record inventory: every workflow under
// <logs>/portify/<id> with its disk size. This is the home for pruning stale
// portify records (the × that used to live in the Ports-tab history) — Open
// opens its feature at Flight → Parallel setup; Delete drops it from history. The scratch
// worktrees these spawned are reclaimed on the Worktrees tab (PORTIFY owner).
export function PortifySection({ now, onNavigateToPortify }: {
  now: number
  onNavigateToPortify?: (feature: string) => void
}) {
  const [workflows, setWorkflows] = useState<PortifyCleanupEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  // Every delete — per-row or bulk — routes through the confirm dialog (like
  // the runs tab), so the "record only, saved overlay untouched" note is seen
  // on each path, not just bulk.
  const [confirmTargets, setConfirmTargets] = useState<PortifyCleanupEntry[] | null>(null)
  // In the page, above the table it is about — this was a `window.alert`, an OS
  // sheet in the middle of a surface that draws all its own chrome.
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const wfs = (await api.cleanupPortify()).workflows
      setWorkflows(wfs)
      // Drop selections for records that no longer exist (removed elsewhere).
      setSelected((prev) => new Set([...prev].filter((id) => wfs.some((w) => w.workflowId === id))))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load Portify records')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const sorted = (workflows ?? []).slice().sort((a, b) => b.folderBytes - a.folderBytes)
  const total = sorted.reduce((s, w) => s + w.folderBytes, 0)

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const selectPreset = (predicate: (w: PortifyCleanupEntry) => boolean): void => {
    setSelected(new Set(sorted.filter(predicate).map((w) => w.workflowId)))
  }
  const presets: Array<{ label: string; predicate: (w: PortifyCleanupEntry) => boolean }> = [
    { label: 'Failed', predicate: (w) => w.status === 'failed' },
    { label: 'Cancelled', predicate: (w) => w.status === 'aborted' },
    { label: 'Failed + cancelled', predicate: (w) => w.status === 'failed' || w.status === 'aborted' },
    { label: 'Older than 7 days', predicate: (w) => now - Date.parse(w.startedAt) > SEVEN_DAYS_MS },
  ]
  const selectedTargets = sorted.filter((w) => selected.has(w.workflowId))
  const selectedBytes = selectedTargets.reduce((s, w) => s + w.folderBytes, 0)

  const doRemove = async (targets: PortifyCleanupEntry[]): Promise<void> => {
    if (targets.length === 0) return
    const n = targets.length
    setConfirmTargets(null)
    setBulkBusy(true)
    const results = await Promise.allSettled(targets.map((w) => api.removePortify(w.workflowId)))
    const failures = results.filter((r) => r.status === 'rejected').length
    // Drop only the removed ids — a per-row delete must not wipe an in-progress
    // bulk selection elsewhere in the table.
    setSelected((prev) => new Set([...prev].filter((id) => !targets.some((t) => t.workflowId === id))))
    setBulkBusy(false)
    await load()
    setActionError(failures > 0 ? `${failures} of ${n} removals failed. Refreshed below.` : null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar mirrors the runs/worktrees views. */}
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
              <span>Records: <strong style={{ color: 'var(--text-primary)' }}>{sorted.length}</strong></span>
              <span>Total on disk: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(total)}</strong></span>
            </>
          )}
          <button type="button" onClick={() => void load()} className="cl-button px-2 py-1" disabled={loading || bulkBusy}>Refresh</button>
        </div>
      </div>
      {actionError && (
        <div role="alert" data-testid="portify-action-error" className="shrink-0 px-5 py-2" style={{ fontSize: 12, color: 'var(--danger)' }}>{actionError}</div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-2">
      {loading && <CleanupEmptyState icon={<SpinnerGlyph />} title="Loading Portify records…" />}
      {!loading && err && (
        <CleanupEmptyState icon={<WarnGlyph />} title="Couldn't load Portify records" hint={err} action={{ label: 'Retry', onClick: () => void load() }} />
      )}
      {!loading && !err && sorted.length === 0 && (
        <CleanupEmptyState
          icon={<FolderGlyph />}
          title="No Portify records"
          hint="Port-ification workflows show up here once you run Portify — prune saved/failed/cancelled records to reclaim disk. Open returns to Parallel setup in Flight."
        />
      )}
      {!loading && !err && sorted.length > 0 && (
        <table className="w-full" style={{ fontSize: 12, color: 'var(--text-secondary)', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              <th className="py-1 pr-2" style={{ width: 28 }} />
              <th className="py-1 pr-3">Suite</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Age</th>
              <th className="py-1 pr-3" style={{ textAlign: 'right' }}>Folder</th>
              <th className="py-1 pl-3 pr-1" style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((w) => (
              <tr key={w.workflowId} style={{ borderTop: '1px solid var(--border-default)' }}>
                <td className="py-1 pr-2">
                  <input
                    type="checkbox"
                    style={{ accentColor: 'var(--accent)' }}
                    checked={selected.has(w.workflowId)}
                    disabled={bulkBusy}
                    onChange={() => toggle(w.workflowId)}
                    aria-label={`Select ${w.feature}`}
                  />
                </td>
                <td className="py-1 pr-3" style={{ color: 'var(--text-primary)' }}>{w.feature}</td>
                <td className="py-1 pr-3"><span style={{ color: PORTIFY_STATUS_COLOR[w.status] }}>{w.status}</span></td>
                <td className="py-1 pr-3">{timeAgo(w.startedAt, now)}</td>
                <td className="py-1 pr-3" style={{ textAlign: 'right', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{formatBytes(w.folderBytes)}</td>
                <td className="py-1 pl-3 pr-1" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {onNavigateToPortify && (
                    <button type="button" onClick={() => onNavigateToPortify(w.feature)} disabled={bulkBusy} className="cl-button px-1.5 py-0.5" style={{ fontSize: 11 }}>Portify</button>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmTargets([w])}
                    disabled={bulkBusy}
                    className="cl-button ml-1 px-1.5 py-0.5"
                    style={{ fontSize: 11, color: 'var(--danger)' }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </div>

      {/* Bottom action bar — identical to the runs/worktrees views'. */}
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
              onClick={() => setConfirmTargets(selectedTargets)}
              disabled={bulkBusy || selectedTargets.length === 0}
              className="cl-button cl-button-danger px-3 py-1"
            >
              {bulkBusy ? 'Removing…' : `Delete records (${selectedTargets.length} · ${formatBytes(selectedBytes)})`}
            </button>
          </div>
        </div>
      )}

      {/* The shared confirmation, serving both the per-row Delete and the bulk
          action bar. */}
      <ConfirmModal
        open={confirmTargets !== null}
        title={`Delete Portify record${confirmTargets?.length === 1 ? '' : 's'}`}
        variant="danger"
        busy={bulkBusy}
        confirmLabel="Delete"
        onCancel={() => setConfirmTargets(null)}
        onConfirm={() => { if (confirmTargets) void doRemove(confirmTargets) }}
        message={<>Remove <strong>{confirmTargets?.length ?? 0}</strong> port-ification record{confirmTargets?.length === 1 ? '' : 's'} from history, reclaiming about <strong>{formatBytes((confirmTargets ?? []).reduce((s, w) => s + w.folderBytes, 0))}</strong>. This drops the workflow record only — a suite&apos;s saved overlay (its live port-ification) is untouched. Remove an overlay from the suite&apos;s Ports tab.</>}
      />
    </div>
  )
}
