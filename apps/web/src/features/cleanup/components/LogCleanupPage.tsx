import { CleanupInventoryFrame } from './CleanupInventoryFrame'
import { useCleanupInventory } from '../state/use-cleanup-inventory'
import { useCleanupSelection } from '../state/use-cleanup-selection'
import { useCleanupAction } from '../state/use-cleanup-action'
import { useMemo, useState } from 'react'
import * as cleanupApi from '@/shared/api/cleanup'
import * as runsApi from '@/shared/api/runs'
import { formatBytes, timeAgo } from '@/shared/lib/format'
import { FullScreenPage, PageHeader } from '@/shared/ui/PageHeader'
import { ConfirmModal } from '@/shared/ui/Overlays'
import { CleanupActionBar, CleanupToolbar, CleanupEmptyState, FolderGlyph, SortHeader } from './CleanupTableParts'
import { PortifySection } from './PortifySection'
import { WorktreesSection } from './WorktreesSection'
import { CLEANUP_TABS, CleanupTab, FOURTEEN_DAYS_MS, HUNDRED_MB, KIND_LABEL, NUMERIC_KEYS, Row, SEVEN_DAYS_MS, STATUS_COLOR, SortKey, THIRTY_DAYS_MS, THREE_DAYS_MS, listingToRows, sortValue } from './cleanup-rows'
import { pluralSuffix } from '@shared/lib/plural'

interface Props {
  onClose: () => void
  // Opens a run in the workspace (selects its feature + run, leaves cleanup).
  // Absent for orphans, which have no manifest/feature to open.
  onNavigateToRun?: (feature: string, runId: string) => void
  // Opens the workflow's feature at Flight → Parallel setup (leaves cleanup).
  onNavigateToPortify?: (feature: string) => void
}

export function LogCleanupPage({ onClose, onNavigateToRun, onNavigateToPortify }: Props) {
  const [view, setView] = useState<CleanupTab>('runs')
  const inventory = useCleanupInventory('runs', cleanupApi.cleanupRuns, view === 'runs')
  const { value: listing, initialLoading: loading, error, refresh } = inventory
  const { busy, error: actionError, execute } = useCleanupAction(refresh)
  const [confirm, setConfirm] = useState<{ action: 'trim' | 'delete'; ids: string[]; bytes: number } | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'folder', dir: 'desc' })

  const rows = useMemo(() => (listing ? listingToRows(listing) : []), [listing])
  const { selected, clear, toggle, selectPreset } = useCleanupSelection(rows, (row) => row.runId, (row) => !row.active, inventory.confirmed)

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
    const eligibleIds = rows.filter((row) => ids.includes(row.runId) && !row.active &&
      (action === 'delete' || (!row.isOrphan && row.artifactBytes > 0))).map((row) => row.runId)
    await execute(eligibleIds, (id) => action === 'trim' ? cleanupApi.trimRun(id) : runsApi.deleteRun(id), clear,
      (failures, total) => `${failures} of ${total} ${action === 'trim' ? 'trims' : 'deletes'} failed (a run may have become active). Refreshed below.`)
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
    // The shared layered stack, not a second document listener: `ConfirmModal`
    // pushes its own layer, so the innermost surface takes Escape and the page
    // beneath stays put. A private listener here raced that — the reason the
    // old one had to test `!confirm` by hand.
    <FullScreenPage onClose={onClose} closeOnEscape={!confirm}>
      {/* The screen says what it is before it says which slice of it you are
          looking at. The tab strip used to sit alone where the name belongs,
          so cleanup was the one full-screen view with no title — the segmented
          control now follows the name instead of standing in for it. */}
      <PageHeader rubric="Workspace" title="Disk cleanup" onClose={onClose} closeLabel="Close cleanup">
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
      </PageHeader>

      {/* Body */}
      {view === 'portify' ? (
        <PortifySection now={now} onNavigateToPortify={onNavigateToPortify} />
      ) : view === 'worktrees' ? (
        <WorktreesSection now={now} />
      ) : (
        <CleanupInventoryFrame
          initialLoading={loading}
          hasSnapshot={listing !== null}
          error={error}
          itemCount={rows.length}
          onRetry={refresh}
          loadingTitle="Computing folder sizes…"
          errorTitle="Couldn't load cleanup data"
          emptyState={
            <CleanupEmptyState icon={<FolderGlyph />} title="No runs on disk" hint="Test, verify, boot and benchmark runs show up here with their disk usage once you record them." />
          }
          toolbar={
            <CleanupToolbar presets={presets} onSelect={selectPreset} selectedCount={selected.size} onClear={clear} busy={busy} loading={inventory.loading} onRefresh={refresh}>
              {totals && <>
                <span>On disk: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(totals.totalBytes)}</strong></span>
                <span>Trimmable: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(totals.reclaimableTrimBytes)}</strong></span>
                <span>Deletable: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(totals.reclaimableDeleteBytes)}</strong></span>
              </>}
            </CleanupToolbar>
          }
          actionError={actionError && (
            <div className="shrink-0 px-5 py-2" style={{ fontSize: 12, color: 'var(--danger)' }}>{actionError}</div>
          )}
        >
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
        </CleanupInventoryFrame>
      )}

      {view === 'runs' && selected.size > 0 && (
        <CleanupActionBar selectedCount={selected.size}>
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
              className="cl-button cl-button-danger px-3 py-1"
            >
              Delete runs ({selected.size} · {formatBytes(deleteBytes)})
            </button>
          </CleanupActionBar>
      )}

      {/* The shared confirmation, not a hand-built one: this page and the
          worktrees tab each carried a near-copy of the same backdrop, heading,
          Cancel/Confirm pair and busy label, free to drift from each other and
          from every other destructive confirm in the app. */}
      <ConfirmModal
        open={confirm !== null}
        title={confirm?.action === 'trim' ? 'Trim artifacts' : 'Delete runs'}
        variant="danger"
        busy={busy}
        confirmLabel={confirm?.action === 'trim' ? 'Trim' : 'Delete'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const c = confirm; setConfirm(null); if (c) void runAction(c.action, c.ids) }}
        message={confirm?.action === 'trim'
          ? <>Delete the Playwright video/trace artifacts for <strong>{confirm.ids.length}</strong> run{pluralSuffix(confirm.ids.length)}, reclaiming about <strong>{formatBytes(confirm.bytes)}</strong>. The runs stay in your history but lose video/trace playback.</>
          : <>Permanently delete <strong>{confirm?.ids.length}</strong> run{pluralSuffix(confirm?.ids.length ?? 0)} and their folders, reclaiming about <strong>{formatBytes(confirm?.bytes ?? 0)}</strong>. This cannot be undone.</>}
      />
    </FullScreenPage>
  )
}
