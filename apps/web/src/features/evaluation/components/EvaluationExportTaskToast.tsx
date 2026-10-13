import { ExternalAgentMonitor } from '@/shared/ui/ExternalAgentMonitor'
import type {
  EvaluationExportMode,
  EvaluationExportTaskView,
} from '@shared/evaluation-export-types'
import { AgentSessionView } from '@/shared/ui/AgentSessionView'
import { type ExternalClientKind } from '@/shared/ui/external-client-branding'
import {
  ExternalStatusPill,
  agentJobTone,
  type PillPalette,
} from '@/shared/ui/ExternalAgentCard'
import { evaluationExportStatus } from '@/shared/lib/agent-job-status'

// R29 (canary-first-flight): the standalone evaluation-export dialog is gone —
// export progress/output renders WHERE the export lives: the flight detail's
// Evaluation Report stage and the run detail's Evaluation panel, both through
// EvaluationTaskOutput below. The FlightsPill narrates a live export as
// "exporting" activity on the feature's row.

/** The one output pane for an evaluation-export task, shared by the flight's
 *  Evaluation Report stage and the run detail's Evaluation panel:
 *  - server-spawned localized rewrite (sessionRef) → live agent timeline
 *  - external (handed-off) export → the shared external-agent card
 *  - raw / cached → the formatted progress text */
export function EvaluationTaskOutput({ task, log }: { task: EvaluationExportTaskView; log: string }) {
  if (task.sessionRef) {
    return (
      <div
        data-testid="evaluation-task-output"
        className="min-h-[240px] flex-1 overflow-hidden rounded-md border"
        style={{ borderColor: 'var(--border-default)', maxHeight: '52vh' }}
      >
        <AgentSessionView
          source={{ kind: 'evaluation', taskId: task.taskId, live: task.status === 'running' }}
        />
      </div>
    )
  }
  if (task.producer === 'external') {
    return <ExternalEvaluationPanel task={task} log={log} />
  }
  const panel = evaluationOutputPanel(task, log)
  return (
    <div data-testid="evaluation-task-output" className="flex min-h-0 min-w-0 flex-col">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {panel.heading}
      </h3>
      <pre
        className="max-h-[52vh] min-h-[200px] overflow-auto rounded-md border p-3 text-[11px] leading-relaxed scrollbar-thin"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
      >
        {panel.text}
      </pre>
    </div>
  )
}

export function modeLabel(mode: EvaluationExportMode): string {
  return mode === 'localized' ? 'Plain-English report' : 'Evidence report'
}

export function evaluationTaskRunLabel(task: Pick<EvaluationExportTaskView, 'feature' | 'runId'>): string {
  return task.feature.trim() || task.runId
}

export function evaluationTaskMeta(task: Pick<EvaluationExportTaskView, 'mode' | 'status' | 'runId'>): string {
  return `${modeLabel(task.mode)} · ${task.status} · ${task.runId}`
}

// The text panel for NON-external tasks (raw lifecycle logs, or a localized
// rewrite that ran without a pinned session — cached or pre-sessionRef). External
// (handed-off) tasks render ExternalEvaluationPanel instead; server-spawned ones
// with a sessionRef stream through AgentSessionView.
export function evaluationOutputPanel(
  task: Pick<EvaluationExportTaskView, 'mode'>,
  rawLog: string,
): { heading: 'Agent output' | 'Export progress'; text: string } {
  const log = rawLog.trim()
  if (task.mode === 'raw') {
    return {
      heading: 'Export progress',
      text: log || 'Waiting for export output...',
    }
  }
  const displayLog = normalizeAgentOutputLog(log)
  if (log.includes('using cached localized wording')) {
    return {
      heading: 'Agent output',
      text: displayLog,
    }
  }
  if (/\[agent:[^\]]+\] starting localized rewrite/.test(log) && !log.includes('localized rewrite completed')) {
    const model = localizedRewriteModel(log)
    const note = model
      ? `The agent process has started with ${model}. Some CLI backends stay quiet until the final response is ready.`
      : 'The agent process has started. Some CLI backends stay quiet until the final response is ready.'
    return {
      heading: 'Agent output',
      text: displayLog.includes(note) ? displayLog : `${note}\n\n${displayLog}`,
    }
  }
  return {
    heading: 'Agent output',
    text: displayLog || 'Awaiting agent output...',
  }
}

// Monitor view for an offloaded (external-producer) evaluation export: the
// rewrite is authored in the user's own client, so we show who is driving it +
// Canary's tracked log on the shared ExternalAgentCard — matching external
// heal / portify / draft / coverage. (Server-spawned localized rewrites carry a
// sessionRef and stream through AgentSessionView instead.)
export function ExternalEvaluationPanel({ task, log }: { task: EvaluationExportTaskView; log: string }) {
  const clientKind = (task.clientKind ?? 'other') as ExternalClientKind
  const { label, palette } = exportStatusPill(task.status)
  return (
    <div data-testid="evaluation-external-monitor" className="min-h-0 flex-1 overflow-auto">
      <ExternalAgentMonitor
        clientKind={clientKind}
        sessionUrl={task.externalSessionUrl}
        sessionId={task.sessionId}
        conversationName={task.conversationName}
        statusPill={<ExternalStatusPill label={label} palette={palette} />}
        body={exportBodyCopy(task.status)}
        displayLog={log.trim() || 'Waiting for the client to submit the evaluation wording…'}
        logTestId="evaluation-external-log"
      />
    </div>
  )
}

// status → pill label/palette. Sky (in-progress) / green (ready) / rose (failed),
// the agent-job hues every external panel shares.
function exportStatusPill(status: EvaluationExportTaskView['status']): { label: string; palette: PillPalette } {
  const palette = agentJobTone(evaluationExportStatus(status))
  if (status === 'completed') return { label: 'Ready', palette }
  if (status === 'failed') return { label: 'Failed', palette }
  return { label: 'Exporting', palette }
}

function exportBodyCopy(status: EvaluationExportTaskView['status']): string {
  if (status === 'completed') {
    return "The evaluation wording was authored in your connected client and submitted — Canary rendered evaluation.html. Download it from the list."
  }
  if (status === 'failed') {
    return 'The external evaluation export did not complete. Reopen your client to retry, or dismiss this task.'
  }
  return "The evaluation wording is being authored in your connected client — open it to follow the agent. Canary renders evaluation.html when the client submits."
}

function localizedRewriteModel(log: string): string | null {
  return log.match(/\[agent:[^\]]+\] starting localized rewrite \(model: ([^)]+)\)/)?.[1] ?? null
}

function normalizeAgentOutputLog(log: string): string {
  if (!log || log.includes('```json')) return log

  const lines = log.split('\n')
  const jsonStartLine = lines.findIndex((line) => line.trimStart().startsWith('{'))
  if (jsonStartLine < 0) return log

  const prefix = lines.slice(0, jsonStartLine).join('\n').trimEnd()
  const tail = lines.slice(jsonStartLine).join('\n').trim()
  const normalized = normalizeJsonTail(tail)
  return `${prefix ? `${prefix}\n\n` : ''}${normalized}`
}

function normalizeJsonTail(tail: string): string {
  const lastBrace = tail.lastIndexOf('}')
  if (lastBrace < 0) return `\`\`\`json\n${tail}\n\`\`\``

  const jsonText = tail.slice(0, lastBrace + 1)
  const suffix = tail.slice(lastBrace + 1).trim()
  let body = jsonText
  try {
    body = JSON.stringify(JSON.parse(jsonText), null, 2)
  } catch {
    body = jsonText
  }
  return `\`\`\`json\n${body}\n\`\`\`${suffix ? `\n${suffix}` : ''}`
}
