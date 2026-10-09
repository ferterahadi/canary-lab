import type { RunQueueDiagnostics } from '@shared/run-queue'
import type { RunIndexEntry } from '@shared/run-index'
import { getRunQueue } from '@/shared/api/runs'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { viewHref } from '@/shared/lib/workspace-view-state'
import { useRuns } from '../state/RunsContext'
import { runWaitingState } from '../utils/run-waiting-state'
import { displayError } from '@/shared/api/error-message'

export function queueExplanation(d: RunQueueDiagnostics): string {
  if (d.reason === 'repo-collision') return 'Another run is using the same repository. This run starts after that repository is released.'
  if (d.reason === 'run-limit') return `The concurrent run limit is ${d.maxConcurrentRuns}; ${d.activeRuns.length} ${d.activeRuns.length === 1 ? 'run currently counts' : 'runs currently count'} toward it.`
  if (d.reason === 'ready') return 'Capacity is available at this check. The run is still queued; the scheduler checks again when an active run finishes.'
  return `The ${d.reason === 'memory' ? 'available-memory' : 'CPU'} budget allows ${d.slotBudget} estimated slots. Active runs use ${d.usedSlots}; this run needs ${d.candidateCost} more. Each service and test runner counts as one slot.`
}

type QueueRead = { diagnostics: RunQueueDiagnostics | null; error?: string }

export function RunQueueBanner({ runId }: { runId: string }) {
  const { runs, connection } = useRuns()
  // The runs stream is the trigger: a completed run can release capacity, and
  // pending review can explain why an active run is still holding it. There is
  // no workspace topic for queue state, so the bus is opted out explicitly.
  const runState = JSON.stringify([connection, runs.map((r) => [r.runId, r.status, r.pendingSpecEdits])])
  // A failed read resolves to an errored result rather than rejecting: the
  // notice clears the explanation and shows the error, while `retainOnError`
  // keeps the previous result on screen through each refetch of the same run.
  const { value: current, loading, refresh } = useLiveResource(null, runId, (id): Promise<QueueRead> =>
    getRunQueue(id).then(({ diagnostics }) => ({ diagnostics }), (err: unknown) => ({ diagnostics: null, error: displayError(err) })),
  { refreshKey: runState, retainOnError: true })
  return <QueueNotice diagnostics={current?.diagnostics ?? null} error={current?.error} runs={runs} loading={loading} onRefresh={refresh} />
}

export function QueueNotice({ diagnostics: d, error, runs, loading, onRefresh }: {
  diagnostics: RunQueueDiagnostics | null; error?: string; runs: RunIndexEntry[]; loading: boolean; onRefresh: () => void
}) {
  const relevant = d?.reason === 'repo-collision'
    ? d.activeRuns.filter((r) => r.runId === d.conflictingRunId) : d?.activeRuns ?? []
  return (
    <div role="status" data-testid="run-queue-banner" className="mt-3 rounded-md border p-3 text-xs" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
      <div className="font-medium text-primary">Queued · Services and tests have not started</div>
      <p className="mt-1">{d ? queueExplanation(d) : loading ? 'Checking why this run is waiting…' : 'Queue details are unavailable. Refresh to check again.'}</p>
      {error && <p className="mt-1 text-danger">{error}</p>}
      {relevant.length > 0 && <div className="mt-2">
        <span>{d?.reason === 'repo-collision' ? 'Repository held by:' : 'Active runs using capacity:'}</span>
        <ul className="mt-1 space-y-1">
          {relevant.map((run) => {
            const entry = runs.find((r) => r.runId === run.runId)
            const waiting = runWaitingState(entry)
            const href = viewHref({ feature: run.feature, run: run.runId, dialog: waiting?.kind === 'test-review' ? 'tests-review' : null })
            return <li key={run.runId}><a className="text-accent underline" href={href}>{run.feature} · {waiting?.label ?? entry?.status ?? 'Active'} →</a></li>
          })}
        </ul>
      </div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={loading} className="cl-button px-2 py-1" onClick={onRefresh}>{loading ? 'Checking…' : 'Refresh queue details'}</button>
        {d && <span className="text-muted">Checked {new Date(d.checkedAt).toLocaleTimeString()}</span>}
      </div>
    </div>
  )
}
