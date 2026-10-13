import { useEffect, useRef, useState } from 'react'
import { useServiceLogLines } from '../state/use-service-logs'
import type { ServiceLogAnchor } from '../utils/results-fixes'

/** Lines of context shown above a linked span. */
export const ANCHOR_CONTEXT_LINES = 20
/** The window one read asks for: enough to hold the span and its context. */
export const ANCHOR_WINDOW_LINES = 600

/**
 * A service's retained log opened at the lines a Results & Fixes excerpt came
 * from. It reads the retained file itself rather than replaying it into the
 * live terminal: a line number then means the same line however the pane is
 * resized or wrapped, and a range older than the terminal's scrollback is
 * still there to read. It never follows new output — Latest output returns to
 * the live terminal.
 */
export function ServiceLogInspector({ runId, anchor, serviceName, onBack, onLatest }: {
  runId: string
  anchor: ServiceLogAnchor
  serviceName: string
  onBack: () => void
  onLatest: () => void
}) {
  const [from, setFrom] = useState(Math.max(1, anchor.startLine - ANCHOR_CONTEXT_LINES))
  const { value, error } = useServiceLogLines(runId, anchor.service, anchor.execution, from, ANCHOR_WINDOW_LINES)
  const firstHighlight = useRef<HTMLDivElement | null>(null)
  const landed = useRef(false)
  // Land on the span once, when its lines first arrive; paging afterwards is
  // the reader's own scrolling.
  useEffect(() => {
    if (!value || landed.current || !firstHighlight.current) return
    landed.current = true
    firstHighlight.current.scrollIntoView({ block: anchor.endLine - anchor.startLine > 12 ? 'start' : 'center' })
  }, [value, anchor.startLine, anchor.endLine])
  const last = value ? value.firstLine + value.lines.length - 1 : 0
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="service-log-inspector">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-[11px]" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)' }}>
        <div className="min-w-[210px] flex-1">
          {anchor.caseTitle && <div className="truncate font-medium" style={{ color: 'var(--text-primary)' }} title={anchor.caseTitle}>{anchor.caseTitle}</div>}
          <p className="m-0 mt-0.5" style={{ color: 'var(--text-secondary)' }} data-testid="service-log-anchor">
            {[serviceName, anchor.context, `execution ${anchor.execution}`, `lines ${anchor.startLine}–${anchor.endLine} highlighted`].filter(Boolean).join(' · ')}
            {anchor.approximate ? ' · chosen by position among spans that share this test’s name' : ''}
          </p>
        </div>
        <button type="button" className="cl-button px-2 py-1" onClick={onBack}>Back to Results &amp; Fixes</button>
        <button type="button" className="cl-button px-2 py-1" onClick={onLatest}>Latest output</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin" style={{ background: 'var(--bg-base)', scrollbarGutter: 'stable' }}>
        {error && (
          <p className="m-0 p-4 text-xs" style={{ color: 'var(--text-muted)' }} data-testid="service-log-unavailable">
            Execution {anchor.execution}&apos;s log for {serviceName} could not be read ({error}). The excerpt in Results &amp; Fixes is what was retained; Latest output shows the live log.
          </p>
        )}
        {!value && !error && <p className="m-0 p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Reading the retained log…</p>}
        {value && (
          <div className="min-w-max py-2 text-[11px] leading-5" style={{ fontFamily: 'var(--font-mono)' }}>
            {value.firstLine > 1 && (
              <PageButton onClick={() => setFrom(Math.max(1, value.firstLine - ANCHOR_WINDOW_LINES))}>Earlier lines</PageButton>
            )}
            {value.lines.map((line, i) => {
              const n = value.firstLine + i
              const marked = n >= anchor.startLine && n <= anchor.endLine
              return (
                <div
                  key={n}
                  ref={n === Math.max(anchor.startLine, value.firstLine) && marked ? firstHighlight : undefined}
                  data-line={n}
                  {...(marked ? { 'data-highlighted': '' } : {})}
                  className="whitespace-pre px-3"
                  style={marked ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
                >
                  <span className="mr-3 inline-block min-w-[3rem] select-none text-right" style={{ color: 'var(--text-muted)' }}>{n}</span>
                  <span style={{ color: 'var(--text-primary)' }}>{line}</span>
                </div>
              )
            })}
            {value.truncated && (
              <PageButton onClick={() => setFrom(last + 1)}>Later lines ({value.totalLines - last} more)</PageButton>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PageButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <div className="px-3 py-1">
      <button type="button" className="cl-button px-2 py-0.5 text-[10.5px]" onClick={onClick}>{children}</button>
    </div>
  )
}
