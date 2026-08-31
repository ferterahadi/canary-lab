/**
 * "Review Evaluation" — the run's deliverable, not the Overview tab's.
 *
 * It used to sit inside the Overview pane, which made it look like a property
 * of that one tab and left it stranded in an otherwise empty strip. It belongs
 * on the run's own tab row, right-aligned opposite the tabs: run-scoped, always
 * reachable, and never competing with the pane's content.
 *
 * R38: the trigger is all that lives here — the export's progress and output are
 * watched via the Flights pill and the flight's Evaluation Report stage.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EvaluationExportMode, EvaluationExportTask } from '@/shared/api/types'
import { useEvaluationExports } from '@/features/evaluation'
import { useMcpPromo } from '@/shared/shell/McpPromoContext'

export function ReviewEvaluationMenu({
  runId,
  onExportStarted,
}: {
  runId: string
  /** The export now lives on Flight's Report stage. Navigation waits for the
   *  task response so a failed start leaves the reader on the run that failed. */
  onExportStarted?: (task: EvaluationExportTask) => void
}) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const { startExport } = useEvaluationExports()
  const { gatePromo } = useMcpPromo()

  const handleExport = useCallback((mode: EvaluationExportMode) => {
    setOpen(false)
    setFailed(false)
    gatePromo('export-evaluation', () => {
      void Promise.resolve(startExport(runId, mode))
        .then((task) => onExportStarted?.(task))
        .catch(() => setFailed(true))
    })
  }, [gatePromo, onExportStarted, runId, startExport])

  // An open menu in a tab row has to close on an outside click — it overlays the
  // pane below it, and leaving it open makes the next click land on the menu
  // instead of what the user aimed at.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Produce the evaluation report and review it — per-test reasoning + verdicts, with video playback where the tests drive a browser. This is the run's deliverable."
        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150"
        style={{ background: 'var(--bg-selected)', color: 'var(--accent)' }}
      >
        <ReportIcon />
        Review Evaluation
        <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="cl-popover absolute right-0 z-30 mt-1 w-44 overflow-hidden py-1 text-xs"
          style={{ color: 'var(--text-primary)' }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport('raw')}
            className="cl-hover-row block w-full px-3 py-2 text-left"
          >
            <span className="block font-medium">Raw output</span>
            <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>Fast report, no LLM rewrite</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport('localized')}
            className="cl-hover-row block w-full px-3 py-2 text-left"
          >
            <span className="block font-medium">Localized output</span>
            <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>Uses the LLM rewrite</span>
          </button>
        </div>
      )}
      {failed && (
        <span className="absolute right-0 top-full mt-1 whitespace-nowrap text-[10px]" style={{ color: 'var(--danger)' }}>
          Export failed
        </span>
      )}
    </div>
  )
}

/** Stroke bar-chart mark. Replaces the 📊 emoji: this UI carries no emoji in its
 *  chrome, and the one colour glyph in a monochrome tab row read as pasted-in. */
function ReportIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 20h16" />
      <path d="M7 20v-6M12 20V6M17 20v-9" />
    </svg>
  )
}
