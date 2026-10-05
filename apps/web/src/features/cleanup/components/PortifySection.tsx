import { CleanupInventoryFrame } from './CleanupInventoryFrame'
import { useCleanupInventory } from '../state/use-cleanup-inventory'
import { useCleanupSelection } from '../state/use-cleanup-selection'
import { useCleanupAction } from '../state/use-cleanup-action'
import { isActionablePortifyStatus } from '@shared/portify-index'
import { useState } from 'react'
import * as cleanupApi from '@/shared/api/cleanup'
import * as portifyApi from '@/shared/api/portify'
import type { PortifyCleanupEntry } from '@shared/cleanup-listing'
import { formatBytes, timeAgo } from '@/shared/lib/format'
import { ConfirmModal } from '@/shared/ui/Overlays'
import { CleanupActionBar, CleanupToolbar, CleanupEmptyState, FolderGlyph } from './CleanupTableParts'
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
  const inventory = useCleanupInventory('portify', cleanupApi.cleanupPortify)
  const workflows = inventory.value?.workflows ?? []
  const { initialLoading: loading, error: err, refresh: load } = inventory
  const { selected, clear, remove: removeSelection, toggle, selectPreset } = useCleanupSelection(workflows, (row) => row.workflowId, (row) => !isActionablePortifyStatus(row.status), inventory.confirmed)
  const { busy: bulkBusy, error: actionError, execute } = useCleanupAction(load)
  // Every delete — per-row or bulk — routes through the confirm dialog (like
  // the runs tab), so the "record only, saved overlay untouched" note is seen
  // on each path, not just bulk.
  const [confirmTargets, setConfirmTargets] = useState<PortifyCleanupEntry[] | null>(null)
  const sorted = workflows.slice().sort((a, b) => b.folderBytes - a.folderBytes)
  const total = sorted.reduce((s, w) => s + w.folderBytes, 0)

  const presets: Array<{ label: string; predicate: (w: PortifyCleanupEntry) => boolean }> = [
    { label: 'Failed', predicate: (w) => w.status === 'failed' },
    { label: 'Cancelled', predicate: (w) => w.status === 'aborted' },
    { label: 'Failed + cancelled', predicate: (w) => w.status === 'failed' || w.status === 'aborted' },
    { label: 'Older than 7 days', predicate: (w) => now - Date.parse(w.startedAt) > SEVEN_DAYS_MS },
  ]
  const selectedTargets = sorted.filter((w) => selected.has(w.workflowId))
  const selectedBytes = selectedTargets.reduce((s, w) => s + w.folderBytes, 0)

  const doRemove = async (targets: PortifyCleanupEntry[]): Promise<void> => {
    setConfirmTargets(null)
    const current = workflows.filter((row) => targets.some((target) => target.workflowId === row.workflowId) && !isActionablePortifyStatus(row.status))
    await execute(current, (row) => portifyApi.removePortify(row.workflowId),
      () => removeSelection(current.map((row) => row.workflowId)),
      (failures, total) => `${failures} of ${total} removals failed. Refreshed below.`)
  }

  return (
    <>
      <CleanupInventoryFrame
        initialLoading={loading}
        hasSnapshot={inventory.value !== null}
        error={err}
        itemCount={sorted.length}
        onRetry={load}
        loadingTitle="Loading Portify records…"
        errorTitle="Couldn't load Portify records"
        emptyState={
          <CleanupEmptyState
            icon={<FolderGlyph />}
            title="No Portify records"
            hint="Port-ification workflows show up here once you run Portify — prune saved/failed/cancelled records to reclaim disk. Open returns to Parallel setup in Flight."
          />
        }
        toolbar={
          <CleanupToolbar presets={sorted.length > 0 ? presets : []} onSelect={selectPreset} selectedCount={selected.size} onClear={clear} busy={bulkBusy} loading={inventory.loading} onRefresh={load}>
            {sorted.length > 0 && <>
              <span>Records: <strong style={{ color: 'var(--text-primary)' }}>{sorted.length}</strong></span>
              <span>Total on disk: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(total)}</strong></span>
            </>}
          </CleanupToolbar>
        }
        actionError={actionError && (
          <div role="alert" data-testid="portify-action-error" className="shrink-0 px-5 py-2" style={{ fontSize: 12, color: 'var(--danger)' }}>{actionError}</div>
        )}
      >
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
                    disabled={bulkBusy || isActionablePortifyStatus(w.status)}
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
                    disabled={bulkBusy || isActionablePortifyStatus(w.status)}
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
      </CleanupInventoryFrame>

      {selected.size > 0 && (
        <CleanupActionBar selectedCount={selected.size}>
            <button
              type="button"
              onClick={() => setConfirmTargets(selectedTargets)}
              disabled={bulkBusy || selectedTargets.length === 0}
              className="cl-button cl-button-danger px-3 py-1"
            >
              {bulkBusy ? 'Removing…' : `Delete records (${selectedTargets.length} · ${formatBytes(selectedBytes)})`}
            </button>
          </CleanupActionBar>
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
    </>
  )
}
