import { useEvaluationExports } from '../state/EvaluationExportContext'
import type { EvaluationExportMode, EvaluationExportTask } from '../api/types'

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

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center">
        <button
          type="button"
          onClick={() => openTask(latestTask.taskId)}
          className="cl-button flex min-w-0 max-w-[260px] items-center gap-2 px-2 py-0.5 text-[11px]"
          style={{ color: 'var(--text-secondary)' }}
          title={`${statusLabel(latestTask)}: ${modeLabel(latestTask.mode)} ${latestTask.runId}`}
        >
          <StatusDot status={latestTask.status} />
          <span className="shrink-0 font-medium" style={{ color: 'var(--text-primary)' }}>
            {compactStatusLabel(latestTask)}
          </span>
          <span className="hidden min-w-0 truncate xl:inline" style={{ color: 'var(--text-muted)' }}>
            {modeLabel(latestTask.mode)}
          </span>
          {tasks.length > 1 && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--bg-selected)', color: 'var(--text-muted)' }}>
              {tasks.length}
            </span>
          )}
        </button>
      </div>
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
        <header className="flex items-start gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-default)' }}>
          <StatusDot status={task.status} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Evaluation export</h2>
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <span className="truncate">Mode: {modeLabel(task.mode)}</span>
              <span className="truncate">Status: {task.status}</span>
              <span className="truncate" title={task.runId}>Run: {task.runId}</span>
              <span className="truncate" title={task.feature}>Feature: {task.feature}</span>
            </div>
          </div>
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
                      <StatusDot status={item.status} />
                      <span className="min-w-0 flex-1 truncate font-medium">{modeLabel(item.mode)}</span>
                    </span>
                    <span className="mt-1 block truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {item.status} · {item.runId}
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
          <section className="min-w-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              {panel.heading}
            </h3>
            <pre
              className="max-h-[52vh] min-h-[260px] overflow-auto rounded-md border p-3 text-[11px] leading-relaxed scrollbar-thin"
              style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
            >
              {panel.text}
            </pre>
          </section>
        </div>
      </section>
    </div>
  )
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function StatusDot({ status }: { status: EvaluationExportTask['status'] }) {
  const cls = status === 'completed'
    ? 'bg-emerald-500'
    : status === 'failed'
      ? 'bg-rose-500'
      : 'animate-pulse bg-sky-500'
  return <span aria-hidden="true" className={`inline-flex h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} />
}

function statusLabel(task: EvaluationExportTask): string {
  if (task.status === 'completed') return 'Evaluation export ready'
  if (task.status === 'failed') return 'Evaluation export failed'
  return `Exporting ${modeLabel(task.mode).toLowerCase()}`
}

function compactStatusLabel(task: EvaluationExportTask): string {
  if (task.status === 'completed') return 'Export ready'
  if (task.status === 'failed') return 'Export failed'
  return 'Exporting'
}

function modeLabel(mode: EvaluationExportMode): string {
  return mode === 'localized' ? 'Localized output' : 'Raw output'
}

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
  if (log.includes('using cached localized wording')) {
    return {
      heading: 'Agent output',
      text: log,
    }
  }
  if (/\[agent:[^\]]+\] starting localized rewrite/.test(log) && !log.includes('localized rewrite completed')) {
    const model = localizedRewriteModel(log)
    const note = model
      ? `The agent process has started with ${model}. Some CLI backends stay quiet until the final response is ready.`
      : 'The agent process has started. Some CLI backends stay quiet until the final response is ready.'
    return {
      heading: 'Agent output',
      text: log.includes(note) ? log : `${note}\n\n${log}`,
    }
  }
  return {
    heading: 'Agent output',
    text: log || 'Waiting for agent output...',
  }
}

function localizedRewriteModel(log: string): string | null {
  return log.match(/\[agent:[^\]]+\] starting localized rewrite \(model: ([^)]+)\)/)?.[1] ?? null
}
