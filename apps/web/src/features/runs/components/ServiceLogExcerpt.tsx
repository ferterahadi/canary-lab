import { useState } from 'react'
import type { EvidenceAttempt, RunEvidence } from '@shared/run-evidence'
import type { ServiceLogExcerpt, ServiceLogSpan, ServiceLogWindow } from '@shared/run-detail'
import { useServiceExcerpts } from '../state/use-service-logs'
import { excerptCaption, excerptGapCopy, markerOccurrence, type ServiceLogAnchor } from '../utils/results-fixes'
import { ResultSection } from './ResultSection'

/**
 * Service logs, the repair story's second section: what each service printed
 * between this attempt's markers, one service at a time in a bounded excerpt.
 * The excerpt is retained evidence from that execution, not a claim that any
 * line caused the failure. Full service log opens the same lines in the
 * Services tab.
 */
export function ServiceLogsSection({ runId, evidence, attempt, label, cycle, caseTitle, onOpenFullLog }: {
  runId: string
  evidence: RunEvidence
  attempt: EvidenceAttempt
  /** "Before this repair", "Initial execution" or "Test result". */
  label: string
  /** The cycle the story is showing, for the full-log view's header. */
  cycle?: string
  caseTitle: string
  onOpenFullLog?: (anchor: ServiceLogAnchor) => void
}) {
  const execution = attempt.executionIndex
  const finished = attempt.endedAt !== undefined
  const latest = evidence.executions.at(-1)?.index ?? 0
  const query = execution !== undefined && finished ? { execution, name: attempt.name, occurrence: markerOccurrence(attempt, evidence) } : null
  const { value, error } = useServiceExcerpts(runId, query, latest)
  const captured = value?.excerpts.filter(isCaptured) ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const selected = captured.find((e) => e.service === picked) ?? captured[0]

  let body
  if (execution === undefined) body = <Muted>This result is not tied to a recorded execution, so its service output cannot be located.</Muted>
  else if (!finished) body = <Muted>Service output for this attempt is still being written.</Muted>
  else if (error) body = <Muted>Failed to read the service logs: {error}</Muted>
  else if (!value) body = <Muted>Reading service logs…</Muted>
  else if (!selected) body = <Muted>{excerptGapCopy(value.excerpts, execution)}</Muted>
  else body = <Excerpt excerpt={selected} label={label} services={captured} onPick={setPicked} />

  const action = selected && onOpenFullLog && (
    <button
      type="button"
      className="cl-button px-2 py-0.5 text-[11px]"
      data-testid="open-full-service-log"
      onClick={() => onOpenFullLog({
        service: selected.service,
        execution: selected.execution,
        startLine: selected.span.startLine,
        endLine: selected.span.endLine,
        approximate: selected.matchedBy === 'order',
        caseTitle,
        context: cycle ? `${cycle} · ${label}` : label,
      })}
    >
      Full service log ↗
    </button>
  )
  return (
    <ResultSection
      title="Service logs"
      context={captured.length > 0 ? `${captured.length} ${captured.length === 1 ? 'service' : 'services'}` : undefined}
      action={action}
      testId="section-service-logs"
    >
      <div className="cl-card-body text-xs">{body}</div>
    </ResultSection>
  )
}

type CapturedExcerpt = ServiceLogExcerpt & { span: ServiceLogSpan; window: ServiceLogWindow }

/** The server sends a span and its window together, or neither. */
function isCaptured(excerpt: ServiceLogExcerpt): excerpt is CapturedExcerpt {
  return excerpt.span !== undefined && excerpt.window !== undefined
}

function Excerpt({ excerpt, label, services, onPick }: {
  excerpt: CapturedExcerpt
  label: string
  services: readonly CapturedExcerpt[]
  onPick: (service: string) => void
}) {
  const window = excerpt.window
  return (
    <>
      <div className="mb-2 flex min-w-0 items-center gap-3 text-[11.5px]">
        {services.length > 1 ? (
          <>
            <label htmlFor={`service-${excerpt.execution}-${excerpt.service}`} className="shrink-0 font-medium" style={{ color: 'var(--text-primary)' }}>Service</label>
            <select
              id={`service-${excerpt.execution}-${excerpt.service}`}
              className="themed-select cl-input min-w-0 flex-1 px-2 py-1 text-xs"
              value={excerpt.service}
              onChange={(e) => onPick(e.target.value)}
            >
              {services.map((s) => <option key={s.service} value={s.service}>{s.name}</option>)}
            </select>
          </>
        ) : (
          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{excerpt.name}</span>
        )}
      </div>
      <p className="mb-2 mt-0 text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }} data-testid="service-excerpt-caption">
        {excerptCaption(excerpt, label)}
      </p>
      {/* Bounded to 160px and scrollable both ways: long lines keep their own
          width instead of wrapping into a second numbered row. */}
      <pre
        tabIndex={0}
        aria-label={`${excerpt.name} output captured during this test`}
        className="m-0 max-h-40 overflow-auto rounded-md border p-2.5 text-[11px] leading-5 scrollbar-thin"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', fontFamily: 'var(--font-mono)', scrollbarGutter: 'stable' }}
        data-testid="service-excerpt"
      >
        {window.lines.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>The service printed nothing during this test.</span> : window.lines.map((line, i) => (
          <span key={window.firstLine + i} className="block whitespace-pre">
            <span className="mr-2.5 inline-block min-w-[2.5rem] select-none text-right" style={{ color: 'var(--text-muted)' }}>{window.firstLine + i}</span>
            {line}
          </span>
        ))}
      </pre>
      <p className="mb-0 mt-2 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
        Printed between this test&apos;s start and end markers{excerpt.matchedBy === 'order' ? ' · chosen by position among spans that share this test’s name' : ''}
        {!excerpt.span.closed ? ' · the end marker never arrived, so the span runs to the end of the log' : ''}.
      </p>
    </>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>{children}</p>
}
