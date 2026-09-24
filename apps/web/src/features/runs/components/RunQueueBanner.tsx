import { useEffect, useState } from 'react'
import type { RunQueueDiagnostics } from '@shared/run-queue'
import type { RunIndexEntry } from '@/shared/api/types'
import { getRunQueue } from '@/shared/api/client'
import { useRuns } from '../state/RunsContext'
import { runWaitingState } from '../utils/run-waiting-state'

export function queueExplanation(d: RunQueueDiagnostics): string {
  if (d.reason === 'repo-collision') return 'Another run is using the same repository. This run starts after that repository is released.'
  if (d.reason === 'run-limit') return `The concurrent run limit is ${d.maxConcurrentRuns}; ${d.activeRuns.length} ${d.activeRuns.length === 1 ? 'run currently counts' : 'runs currently count'} toward it.`
  if (d.reason === 'ready') return 'Capacity is available at this check. The run is still queued; the scheduler checks again when an active run finishes.'
  return `The ${d.reason === 'memory' ? 'available-memory' : 'CPU'} budget allows ${d.slotBudget} estimated slots. Active runs use ${d.usedSlots}; this run needs ${d.candidateCost} more. Each service and test runner counts as one slot.`
}

export function RunQueueBanner({ runId }: { runId: string }) {
  const { runs, connection } = useRuns()
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{ runId: string; diagnostics: RunQueueDiagnostics | null; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  // The runs stream is the trigger: a completed run can release capacity, and
  // pending review can explain why an active run is still holding it.
  const runState = JSON.stringify(runs.map((r) => [r.runId, r.status, r.pendingSpecEdits]))
  useEffect(() => {
    let alive = true
    setLoading(true)
    getRunQueue(runId).then(({ diagnostics }) => {
      if (alive) setResult({ runId, diagnostics })
    }).catch((err) => {
      if (alive) setResult({ runId, diagnostics: null, error: err instanceof Error ? err.message : String(err) })
    }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [runId, runState, connection, retry])
  const current = result?.runId === runId ? result : null
  return <QueueNotice diagnostics={current?.diagnostics ?? null} error={current?.error} runs={runs} loading={loading} onRefresh={() => setRetry((n) => n + 1)} />
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
            const params = new URLSearchParams({ feature: run.feature, run: run.runId })
            if (waiting?.kind === 'test-review') params.set('dialog', 'tests-review')
            return <li key={run.runId}><a className="text-accent underline" href={`?${params}`}>{run.feature} · {waiting?.label ?? entry?.status ?? 'Active'} →</a></li>
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
