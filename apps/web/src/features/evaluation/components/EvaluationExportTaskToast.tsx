import { useEvaluationExports } from '../state/EvaluationExportContext'
import type { EvaluationExportMode, EvaluationExportTask } from '../../../shared/api/types'
import { AgentSessionView } from '../../agent-sessions/components/AgentSessionView'
import { CloseIcon, DownloadIcon, StatusDot, type StatusDotState } from '../../config/components/atoms'
import { StatusPill } from '../../../shared/ui/StatusPill'

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
              // A localized-rewrite agent ran for this task — stream its JSONL
              // through the shared agent timeline, same as every other agent
              // surface. Raw/external/cached runs have no sessionRef and keep
              // the text panel below.
              <div
                className="min-h-[260px] flex-1 overflow-hidden rounded-md border"
                style={{ borderColor: 'var(--border-default)', maxHeight: '52vh' }}
              >
                <AgentSessionView
                  source={{ kind: 'evaluation', taskId: task.taskId, live: task.status === 'running' }}
                />
              </div>
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

export function evaluationOutputPanel(
  task: Pick<EvaluationExportTask, 'mode' | 'producer' | 'clientKind' | 'conversationName' | 'sessionId'>,
  rawLog: string,
): { heading: 'Agent output' | 'Export progress'; text: string } {
  if (task.producer === 'external') {
    const details = [
      'Generated using external client.',
      task.clientKind ? `Client: ${task.clientKind}` : null,
      task.conversationName ? `Conversation: ${task.conversationName}` : null,
      task.sessionId ? `Session: ${task.sessionId}` : null,
    ].filter(Boolean)
    return {
      heading: 'Export progress',
      text: details.join('\n'),
    }
  }
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
