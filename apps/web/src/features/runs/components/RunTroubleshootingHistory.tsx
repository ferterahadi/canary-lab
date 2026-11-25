import type { RunDetail } from '@shared/run-detail'
import type { RunHistoryEntry } from '@shared/run-collaboration'
import { getRunHistory } from '@/shared/api/runs'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { viewHref } from '@/shared/lib/workspace-view-state'

export function RunTroubleshootingHistory({ detail }: { detail: RunDetail }) {
  const history = useLiveResource<RunHistoryEntry[]>('journal', detail.runId, getRunHistory, {
    scope: detail.runId, reconcileMs: 5000, leaseMs: 15000, pauseWhenHidden: true,
    refreshKey: detail.collaboration?.revision ?? detail.manifest.status,
  })
  if (!history.value?.length) return history.error ? <p role="status">Troubleshooting history is unavailable. Retrying…</p> : null
  return <section className="cl-card m-3" aria-label="Troubleshooting history">
    <div className="cl-card-head"><h2 className="cl-rubric">Troubleshooting history</h2></div>
    <div className="cl-card-body space-y-3 text-xs">
      {history.error && <p role="status">History may be stale. Retrying…</p>}
      {history.value.map((run) => <section key={run.runId}>
        <p><a className="text-accent" href={viewHref({ feature: run.feature, run: run.runId })}>{run.runId}</a> · {run.status}</p>
        {!run.executions.length && <p className="text-muted">Per-execution source evidence is unavailable for this older run.</p>}
        {run.executions.map((execution) => <p key={execution.index}>
          Execution {execution.index} · {execution.recovered ? 'historical result; execution details unavailable' : execution.endedAt ? `exit ${execution.exitCode}` : 'in progress'} · {execution.selection}
          {' · '}{execution.sourceVersion ? `source ${execution.sourceVersion.slice(0, 8)}` : 'source unavailable'}
          {' · '}<a className="text-accent" href={`/api/runs/${encodeURIComponent(run.runId)}/executions/${execution.index}/output`} target="_blank" rel="noreferrer">Output</a>
          {execution.summaryPath && <> · <a className="text-accent" href={`/api/runs/${encodeURIComponent(run.runId)}/executions/${execution.index}/summary`} target="_blank" rel="noreferrer">Results</a></>}
        </p>)}
        {run.journal.map((entry) => <p key={entry.iteration}>
          {entry.inputExecution ? `After execution ${entry.inputExecution}: ` : ''}{entry.hypothesis ?? `Journal entry ${entry.iteration}`} · {entry.outcome ?? 'recorded'}
        </p>)}
      </section>)}
    </div>
  </section>
}
