import type { ExecutionType } from '@shared/verification'
import type { RunDetail } from '@shared/run-detail'
import type { RunIndexEntry } from '@shared/run-index'
import type { RunStatus } from '@shared/run-state'
import { StatusDot } from '@/shared/ui/atoms'
import { Chip } from '@/shared/ui/StatusChip'
import { runWaitingState, type RunWaitingState } from '../utils/run-waiting-state'
import { presentRunStatus } from '../utils/run-presentation'
import { shortTime } from '@/shared/lib/format'

// One run row + its status chip, extracted verbatim from RunsListDialog (R64)
// so the flight's run stage can render the same row as the runs list. Chrome
// mirrors the EvaluationExportTaskToast / WizardTaskStatus dialogs (leading
// status dot + pill chip) so run/task surfaces read as one family.

const CHROME_CLASS = {
  row: 'rounded-md px-3 py-2 cl-hover-row',
  headline: 'pb-0.5',
  item: 'py-1.5',
} as const

function portsLabel(detail: RunDetail | undefined): string | null {
  const ports = (detail?.manifest.services ?? [])
    .flatMap((s) => Object.values(s.allocatedPorts ?? {}))
  return ports.length > 0 ? ports.map((p) => `:${p}`).join(' ') : null
}

function queueNote(entry: RunIndexEntry, detail: RunDetail | undefined): string | null {
  if (entry.status !== 'queued') return null
  const reason = detail?.manifest.queueReason
  if (reason === 'repo-collision') return 'waiting for the same app to finish'
  if (reason === 'resources') return 'waiting for resources'
  return 'queued'
}

export function RunRow({
  run,
  detail,
  onSelect,
  primaryLabel,
  marker,
  showPorts = true,
  passCount = 'meta',
  arrow = 'hover',
  chrome = 'row',
}: {
  run: RunIndexEntry
  detail: RunDetail | undefined
  onSelect: (run: RunIndexEntry) => void
  /** Override the bold identity line (default `run.feature`). The Test Run
   *  hero passes "Run <ref>" so the run reads as an object, not a feature row. */
  primaryLabel?: string
  /** Extra trailing meta segment (e.g. "run 2 of 2") — the hero's ordinal. */
  marker?: string
  /** Show the allocated-ports meta segment. The hero hides it (ports belong on
   *  the Services tile's tooltip, not the identity line). */
  showPorts?: boolean
  /** Where the pass count goes. 'meta' (default) puts it in the meta line with
   *  the timestamp; 'promoted' gives it its own segment beside the status chip.
   *  'hidden' drops it — for a surface that already states the score bigger
   *  elsewhere (the flight run stage's Tests-passed tile), where repeating it a
   *  hand's width away just reads as two different facts. */
  passCount?: 'meta' | 'promoted' | 'hidden'
  /** When the trailing `→` shows. Default 'hover' (the runs list, where rows are
   *  scanned in bulk and a column of arrows would be noise). 'always' is for a
   *  short list whose whole point is going somewhere — the flight run stage's
   *  Previous runs — so the affordance reads at rest. */
  arrow?: 'hover' | 'always'
  /** `row` (default) is a list item: its own gutter, rounding and hover fill,
   *  scanned among siblings. `headline` is a card's own opening line — the
   *  flight run stage's Latest run. It drops the gutter so its text starts on
   *  the card's OWN left edge (the column the kicker, the stats line and the
   *  failure rows share), and it drops the fill: a filled band the width of the
   *  card read as a nested slab, and it cut the run's title off from the stats
   *  line that belongs to it. Hover underlines the title instead, and the
   *  always-on arrow carries the affordance at rest. `item` is a list row
   *  INSIDE a card (the run stage's Previous runs): headline's flush edge and
   *  underline, with the vertical rhythm of the Failing tests rows beside it. */
  chrome?: 'row' | 'headline' | 'item'
}) {
  const ports = showPorts ? portsLabel(detail) : null
  const note = queueNote(run, detail)
  const waiting = runWaitingState(detail ?? run)
  const presentation = presentRunStatus({ status: run.status, executionType: run.executionType, waiting })
  const meta: Array<{ text: string; mono?: boolean }> = [{ text: shortTime(run.startedAt) }]
  // The envset sits next to the timestamp — when and where, before any outcome.
  // Spec selection cannot vary by envset, so sibling runs of one suite declare
  // the same roster and differ only in what the environment let execute: this is
  // what separates "41/45 passed" from "4/45 passed" on the row below it.
  if (run.env) meta.push({ text: run.env })
  if (ports) meta.push({ text: ports, mono: true })
  if (note) meta.push({ text: note })
  if (marker) meta.push({ text: marker })
  const summary = detail?.summary
  const passLabel = summary && summary.total > 0 ? `${summary.passed}/${summary.total} passed` : null
  if (passLabel && passCount === 'meta') meta.push({ text: passLabel })
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(run)}
        className={`group flex w-full items-center gap-2 text-left ${CHROME_CLASS[chrome]}`}
        title={`Go to run ${run.runId}`}
      >
        <StatusDot state={presentation.dot} pulse={presentation.pulse} halo={presentation.pulse && presentation.dot !== 'booted'} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={`truncate text-[13px] ${chrome === 'row' ? '' : 'group-hover:underline'}`}
            style={{ color: 'var(--text-primary)', fontWeight: 500 }}
          >
            {primaryLabel ?? run.feature}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {meta.map((part, i) => (
              <span key={i} className="flex min-w-0 items-center gap-1.5">
                {i > 0 && <Sep />}
                <span
                  className={part.mono ? 'shrink-0' : 'truncate'}
                  style={part.mono ? { fontFamily: 'var(--font-mono)' } : undefined}
                >
                  {part.text}
                </span>
              </span>
            ))}
          </span>
        </span>
        {passCount === 'promoted' && passLabel && (
          <span
            className="shrink-0 text-[11px] tabular-nums"
            style={{ color: 'var(--text-secondary)' }}
          >
            {passLabel}
          </span>
        )}
        <RunStatusChip status={run.status} executionType={run.executionType} pendingSpecEdits={run.pendingSpecEdits} waiting={waiting} />
        <span
          className={`shrink-0 transition-opacity ${arrow === 'always' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          style={{ color: 'var(--accent)' }}
          aria-hidden="true"
        >
          →
        </span>
      </button>
    </li>
  )
}

/** The status chip, plus — for an active run holding spec edits it has not
 *  executed (D9) — a quiet "N pending" companion. It sits WITH the status because
 *  that is the claim it qualifies: HEALING or PASSED describes the suite as it
 *  stood at run start, and this says the live suite has since moved. Border
 *  chrome and muted tone: a fact about provenance, not an alarm (the danger
 *  reading, if any, is the features column's weaker badge). The count is
 *  mirrored onto the runs index by the server so this needs no detail read. */
export function RunStatusChip({ status, executionType, pendingSpecEdits, waiting }: { status: RunStatus; executionType?: ExecutionType; pendingSpecEdits?: number; waiting?: RunWaitingState }) {
  const presentation = presentRunStatus({ status, executionType, waiting })
  const pending = pendingSpecEdits ?? 0
  return (
    <>
      {pending > 0 && (
        <Chip
          chrome="border"
          tone="var(--text-muted)"
          label={`${pending} pending`}
          fontSize={10}
          testId="run-pending-edits"
          title={`${pending} test-file change${pending > 1 ? 's' : ''} made since this run started ${pending > 1 ? 'have' : 'has'} not run. This run result is based on the recorded tests. Review, then adopt or restore the changes under Tests changed.`}
        />
      )}
      <Chip
        chrome="fill"
        tone={presentation.tone}
        background={presentation.background}
        label={presentation.label}
        title={presentation.title}
        uppercase
        fontSize={10}
        fontWeight={600}
      />
    </>
  )
}

function Sep() {
  return (
    <span aria-hidden="true" className="select-none" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
      ·
    </span>
  )
}
