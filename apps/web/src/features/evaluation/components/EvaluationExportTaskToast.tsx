import { useEvaluationExports } from '../state/EvaluationExportContext'
import type { EvaluationExportMode, EvaluationExportTask } from '../../../shared/api/types'
import { AgentSessionView } from '../../agent-sessions/components/AgentSessionView'
import { CloseIcon, DownloadIcon, StatusDot, type StatusDotState } from '../../config/components/atoms'
import { StatusPill } from '../../../shared/ui/StatusPill'
import { clientKindToDesktopAgent, clientLabel, clientTint, shortSession, type ExternalClientKind } from '../../runs/components/external-client-branding'
import {
  ExternalAgentCard,
  ExternalClientCta,
  pillPalette,
  StatusPill as CardStatusPill,
  useOpenAgentApp,
  type PillPalette,
} from '../../runs/components/ExternalAgentCard'

function dotStateForExport(status: EvaluationExportTask['status']): StatusDotState {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'failed'
  return 'running'
}

export function EvaluationExportTaskStatus() {
  const {
    tasks,
    latestTask,
    selectedTask,
    dialogOpen,
    logsByTaskId,
    openTask,
    closeDialog,
    downloadTask,
    dismissTask,
  } = useEvaluationExports()

  if (!latestTask) return null

  const task = selectedTask ?? latestTask
  const latestRunLabel = evaluationTaskRunLabel(latestTask)

  return (
    <>
      <StatusPill
        dotState={dotStateForExport(latestTask.status)}
        name="Exports"
        detail={compactStatusLabel(latestTask)}
        count={tasks.length > 1 ? tasks.length : undefined}
        onClick={() => openTask(latestTask.taskId)}
        title={`${statusLabel(latestTask)} · ${latestRunLabel}`}
      />
      {dialogOpen && task && (
        <EvaluationExportDialog
          tasks={tasks}
          task={task}
          log={logsByTaskId[task.taskId] ?? ''}
          logsByTaskId={logsByTaskId}
          onSelectTask={openTask}
          onClose={closeDialog}
          onDownloadTask={(taskId) => void downloadTask(taskId)}
          onDismissTask={(taskId) => void dismissTask(taskId)}
        />
      )}
    </>
  )
}

function EvaluationExportDialog({
  tasks,
  task,
  log,
  logsByTaskId,
  onSelectTask,
  onClose,
  onDownloadTask,
  onDismissTask,
}: {
  tasks: EvaluationExportTask[]
  task: EvaluationExportTask
  log: string
  logsByTaskId: Record<string, string>
  onSelectTask: (taskId: string) => void
  onClose: () => void
  onDownloadTask: (taskId: string) => void
  onDismissTask: (taskId: string) => void
}) {
  const panel = evaluationOutputPanel(task, log || logsByTaskId[task.taskId] || '')

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-end bg-black/30 p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Evaluation export task"
        className="flex max-h-[calc(100vh-3rem)] w-[min(980px,calc(100vw-3rem))] flex-col rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
      >
        <header className="cl-dialog-header">
          <h2 className="min-w-0 flex-1 text-sm font-semibold">Evaluation export</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs"
            style={{ color: 'var(--text-secondary)' }}
          >
            Close
          </button>
        </header>
        {task.error && (
          <div className="mx-4 mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {task.error}
          </div>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-3 p-4">
          <aside
            className="min-h-0 overflow-auto rounded-md border p-2 scrollbar-thin"
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)' }}
            aria-label="Evaluation export tasks"
          >
            {tasks.map((item) => {
              const active = item.taskId === task.taskId
              const runLabel = evaluationTaskRunLabel(item)
              return (
                <div
                  key={item.taskId}
                  className="mb-1 flex items-center gap-1 rounded"
                  style={{
                    background: active ? 'var(--bg-selected)' : 'transparent',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelectTask(item.taskId)}
                    className="min-w-0 flex-1 rounded px-2 py-2 text-left text-xs"
                    style={{
                      background: 'transparent',
                      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <StatusDot state={dotStateForExport(item.status)} />
                      <span className="min-w-0 flex-1 truncate font-medium" title={runLabel}>
                        {runLabel}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {evaluationTaskMeta(item)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Download ${modeLabel(item.mode)} evaluation export`}
                    title={item.downloadReady ? 'Download' : 'Download is available when export completes'}
                    disabled={!item.downloadReady}
                    onClick={() => onDownloadTask(item.taskId)}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-35"
                    style={{ color: item.downloadReady ? 'var(--accent)' : 'var(--text-muted)' }}
                  >
                    <DownloadIcon />
                  </button>
                  <button
                    type="button"
                    aria-label={`Dismiss ${modeLabel(item.mode)} evaluation export`}
                    title={item.status === 'running' ? 'Cancel export' : 'Dismiss'}
                    onClick={() => onDismissTask(item.taskId)}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <CloseIcon />
                  </button>
                </div>
              )
            })}
          </aside>
          <section className="flex min-h-0 min-w-0 flex-col">
            {task.sessionRef ? (
              // A localized-rewrite agent ran for this task ON THE SERVER (GUI
              // path) — stream its JSONL through the shared agent timeline, same
              // as every other server-spawned agent surface.
              <div
                className="min-h-[260px] flex-1 overflow-hidden rounded-md border"
                style={{ borderColor: 'var(--border-default)', maxHeight: '52vh' }}
              >
                <AgentSessionView
                  source={{ kind: 'evaluation', taskId: task.taskId, live: task.status === 'running' }}
                />
              </div>
            ) : task.producer === 'external' ? (
              // Handed-off to the calling client (Desktop/CLI): no server agent
              // to stream, so show the shared external-agent card — matching
              // external heal / portify / draft / coverage.
              <ExternalEvaluationPanel task={task} log={log || logsByTaskId[task.taskId] || ''} />
            ) : (
              <>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {panel.heading}
                </h3>
                <pre
                  className="max-h-[52vh] min-h-[260px] overflow-auto rounded-md border p-3 text-[11px] leading-relaxed scrollbar-thin"
                  style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
                >
                  {panel.text}
                </pre>
              </>
            )}
          </section>
        </div>
      </section>
    </div>
  )
}

function statusLabel(task: EvaluationExportTask): string {
  if (task.status === 'completed') return 'Evaluation export ready'
  if (task.status === 'failed') return 'Evaluation export failed'
  return `Exporting ${modeLabel(task.mode).toLowerCase()}`
}

// Short status word shown as the pill's muted detail. The pill name already
// says "Exports", so this drops the redundant "Export" prefix.
function compactStatusLabel(task: EvaluationExportTask): string {
  if (task.status === 'completed') return 'Ready'
  if (task.status === 'failed') return 'Failed'
  return 'Exporting'
}

function modeLabel(mode: EvaluationExportMode): string {
  return mode === 'localized' ? 'Localized output' : 'Raw output'
}

export function evaluationTaskRunLabel(task: Pick<EvaluationExportTask, 'feature' | 'runId'>): string {
  return task.feature.trim() || task.runId
}

export function evaluationTaskMeta(task: Pick<EvaluationExportTask, 'mode' | 'status' | 'runId'>): string {
  return `${modeLabel(task.mode)} · ${task.status} · ${task.runId}`
}

// The text panel for NON-external tasks (raw lifecycle logs, or a localized
// rewrite that ran without a pinned session — cached or pre-sessionRef). External
// (handed-off) tasks render ExternalEvaluationPanel instead; server-spawned ones
// with a sessionRef stream through AgentSessionView.
export function evaluationOutputPanel(
  task: Pick<EvaluationExportTask, 'mode'>,
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
    text: displayLog || 'Waiting for agent output...',
  }
}

// Monitor view for an offloaded (external-producer) evaluation export: the
// rewrite is authored in the user's own client, so we show who is driving it +
// Canary's tracked log on the shared ExternalAgentCard — matching external
// heal / portify / draft / coverage. (Server-spawned localized rewrites carry a
// sessionRef and stream through AgentSessionView instead.)
export function ExternalEvaluationPanel({ task, log }: { task: EvaluationExportTask; log: string }) {
  const clientKind = (task.clientKind ?? 'other') as ExternalClientKind
  const { opening, error: openError, open } = useOpenAgentApp()
  // Jump-to-agent: prefer the client's own conversation deep-link; otherwise
  // launch the desktop app for a known client. PTY/unknown → no CTA.
  const desktopAgent = clientKindToDesktopAgent(clientKind)
  const tint = clientTint(clientKind)
  const { label, palette } = exportStatusPill(task.status)
  return (
    <div data-testid="evaluation-external-monitor" className="min-h-0 flex-1 overflow-auto">
      <ExternalAgentCard
        clientKind={clientKind}
        eyebrow="External evaluation export session"
        headline={clientKind === 'other' ? 'External Client' : clientLabel(clientKind)}
        subtitle={task.conversationName}
        statusPill={<CardStatusPill label={label} palette={palette} />}
        meta={
          task.sessionId && (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
              <span aria-hidden style={{ opacity: 0.55 }}>·</span>
              <span style={{ fontFamily: 'var(--font-mono)' }} title={task.sessionId}>
                {shortSession(task.sessionId)}
              </span>
            </span>
          )
        }
        body={exportBodyCopy(task.status)}
      >
        <pre
          data-testid="evaluation-external-log"
          style={{
            margin: '12px 0 0', maxHeight: 300, overflow: 'auto', fontSize: 12, lineHeight: 1.5,
            color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}
        >
          {log.trim() || 'Waiting for the client to submit the evaluation wording…'}
        </pre>

        {(task.externalSessionUrl || desktopAgent) && (
          <div className="mt-3 @[320px]:mt-4 @[480px]:mt-5">
            {task.externalSessionUrl ? (
              <ExternalClientCta tint={tint} label={`Open ${clientLabel(clientKind)}`} href={task.externalSessionUrl} />
            ) : (
              desktopAgent && (
                <ExternalClientCta
                  tint={tint}
                  label={`Open ${desktopAgent === 'claude' ? 'Claude' : 'Codex'}`}
                  onClick={() => open(desktopAgent)}
                  busy={opening !== null}
                />
              )
            )}
          </div>
        )}
        {openError && (
          <div className="mt-3 text-[11px]" style={{ color: 'var(--danger)' }}>
            {openError}
          </div>
        )}
      </ExternalAgentCard>
    </div>
  )
}

// status → pill label/palette. Sky (in-progress) / green (ready) / rose (failed),
// reusing the shared status hues.
function exportStatusPill(status: EvaluationExportTask['status']): { label: string; palette: PillPalette } {
  if (status === 'completed') return { label: 'Ready', palette: pillPalette('var(--success)') }
  if (status === 'failed') return { label: 'Failed', palette: pillPalette('var(--danger)') }
  return { label: 'Exporting', palette: pillPalette('var(--border-focus)') }
}

function exportBodyCopy(status: EvaluationExportTask['status']): string {
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
