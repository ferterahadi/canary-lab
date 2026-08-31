import { useEffect, useState } from 'react'
import type { EvaluationExportTask } from '@/shared/api/types'
import { StatusDot, type StatusDotState } from '@/shared/ui/atoms'
import { useEvaluationExportLog, useEvaluationExports } from '../state/EvaluationExportContext'
import { EvaluationTaskOutput, modeLabel } from './EvaluationExportTaskToast'

function dotStateForExport(status: EvaluationExportTask['status']): StatusDotState {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'failed'
  return 'running'
}

/** One evaluation-export task, in place (R29): status line, the task's output
 *  (agent timeline / external card / progress text), and the download once the
 *  archive is ready. Shared by the run detail's Evaluation section and the
 *  flight detail's Evaluation Report stage — the two homes that replaced the
 *  standalone export dialog. */
export function EvaluationTaskPanel({
  task,
  showDownload = true,
}: {
  task: EvaluationExportTask
  /** The flight stage header already carries its own download action. */
  showDownload?: boolean
}) {
  const { watchTask, downloadTask } = useEvaluationExports()
  // Subscribe only to this task's log; another export may stream concurrently.
  const { log } = useEvaluationExportLog(task.taskId)
  const [downloadFailed, setDownloadFailed] = useState(false)
  // Attach the log stream when this panel surfaces a task it didn't start
  // (cold load onto a running export) — no-op when already streaming.
  useEffect(() => { watchTask(task.taskId) }, [task.taskId, watchTask])

  return (
    <section data-testid="evaluation-task-panel" className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <StatusDot state={dotStateForExport(task.status)} className="shrink-0" />
        <span className="text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
          {modeLabel(task.mode)} · {task.status}
        </span>
        <div className="flex-1" />
        {showDownload && task.downloadReady && (
          <button
            type="button"
            data-testid="evaluation-task-download"
            onClick={() => {
              setDownloadFailed(false)
              downloadTask(task.taskId).catch(() => setDownloadFailed(true))
            }}
            className="cl-button shrink-0 px-2.5 py-1 text-xs"
            style={{ color: downloadFailed ? 'var(--danger)' : 'var(--success)' }}
          >
            {/* "report" — the same word the flight header and the reports list
                use for this same file; three labels for one download read as
                three different files. */}
            {downloadFailed ? 'Download failed — retry' : '⬇ Download report'}
          </button>
        )}
      </div>
      {task.error && (
        <div className="rounded border px-2.5 py-2 text-[11.5px]" style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-default))', color: 'var(--danger)' }}>
          {task.error}
        </div>
      )}
      <EvaluationTaskOutput task={task} log={log} />
    </section>
  )
}
