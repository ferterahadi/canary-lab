import { useState } from 'react'
import type { RobustnessFinding, RobustnessJobManifest } from '@shared/robustness/jobs'
import type { RobustnessAtomKind, RobustnessEnvelope } from '@shared/robustness/types'
import { reproLine } from '@shared/robustness/shrink'
import { MatrixCell, type MatrixCellState } from '@/features/benchmark'
import { PanelCard, panelCardClass, panelCardStyle } from '@/shared/ui/PanelCard'
import { SkeletonPanel, type AwaitingState } from '@/shared/ui/Skeleton'
import { STAGE_COLUMN, StageColumn } from './stage-meta'
import { plural } from './StageFacts'

// The Robustness Lab stage's evidence blocks (D16). The band above counts cells
// and findings; these name them. The matrix says WHICH spec file broke under
// WHICH disturbance (and which cells nobody could judge); each finding then gets
// its own card — the tests that failed, the smallest envelope that still fails
// them, the shrink trace that got there, and the one action a finding wants:
// send it to repair, i.e. start a run under that envelope so the repair agent
// works on a failure that reproduces.
//
// A finding is a defect the green run did not see, so its card takes the danger
// treatment the failed-stage panel uses — the same hue for the same meaning. It
// is the ONE accent on this pane; the matrix and the band stay neutral.

const ATOM_LABEL: Record<RobustnessAtomKind, string> = {
  latency: 'Latency',
  duplicate: 'Duplicate',
  restart: 'Restart',
}

/** The atoms this envelope declares, in the matrix's column order. */
export function envelopeAtoms(envelope: RobustnessEnvelope): RobustnessAtomKind[] {
  return [
    ...(envelope.latency ? ['latency' as const] : []),
    ...(envelope.duplicate ? ['duplicate' as const] : []),
    ...(envelope.restart && envelope.restart.length > 0 ? ['restart' as const] : []),
  ]
}

/** The key `RobustnessFindingsPanel.sending` compares against. */
export function robustnessFindingKey(f: RobustnessFinding): string {
  return `${f.cell.specFile} ${f.cell.atom}`
}

/** What a finding's status means, in the words the state line uses: a finding
 *  is confirmed only when its shrunk envelope reproduced every time it was
 *  replayed; one that did not stays listed as such. */
export function findingStatusLabel(f: RobustnessFinding): string {
  switch (f.status) {
    case 'found': return 'found — shrink queued'
    case 'shrinking': return 'shrinking…'
    case 'confirmed': return `confirmed ${f.shrink?.confirmations.reproduced ?? 3}/${f.shrink?.confirmations.asked ?? 3}`
    case 'unconfirmed': return `unconfirmed — reproduced ${f.shrink?.confirmations.reproduced ?? 0}/${f.shrink?.confirmations.asked ?? 3}`
  }
}

/** Perturbation matrix: spec files × the envelope's atoms. Only a file that
 *  failed or was skipped somewhere has a row — a clean cell leaves no record,
 *  which is why the footer states the clean count instead of drawing it. While
 *  the matrix runs, a cell with no record is not yet judged, not passed. */
export function RobustnessMatrixPanel({ job, awaiting }: { job: RobustnessJobManifest | null; awaiting?: AwaitingState }) {
  const kicker = 'Perturbation matrix'
  if (!job) {
    return awaiting ? <StageColumn><SkeletonPanel kicker={kicker} awaiting={awaiting} testId="robustness-matrix-skeleton" variant="rows" rows={3} /></StageColumn> : null
  }
  const atoms = envelopeAtoms(job.envelope)
  const findings = new Map(job.findings.map((f) => [robustnessFindingKey(f), f]))
  const skipped = new Map(job.skipped.map((s) => [`${s.cell.specFile} ${s.cell.atom}`, s]))
  const files = [...new Set([...job.findings, ...job.skipped].map((entry) => entry.cell.specFile))].sort()
  const running = job.status === 'running'
  const clean = job.cells.done - job.findings.length - job.skipped.length
  const cellFor = (file: string, atom: RobustnessAtomKind): { state: MatrixCellState; title: string } => {
    const key = `${file} ${atom}`
    const finding = findings.get(key)
    if (finding) return { state: 'failed', title: `${plural(finding.failedTests.length, 'test')} failed · ${findingStatusLabel(finding)}` }
    const skip = skipped.get(key)
    if (skip) return { state: 'skipped', title: `not judged — ${skip.reason}` }
    return running ? { state: 'pending', title: 'not run yet, or held' } : { state: 'yes', title: 'held' }
  }
  const cols = `minmax(0, 1fr) repeat(${atoms.length}, 84px)`
  return (
    <StageColumn>
      <PanelCard kicker={kicker} testId="robustness-matrix" aside={<span className="cl-type-meta text-muted">{atoms.map((a) => ATOM_LABEL[a]).join(' · ')}</span>}>
        {files.length === 0 ? (
          <p data-testid="robustness-matrix-empty" className="m-0 cl-type-body text-secondary">
            {running ? 'No cell has failed or been skipped so far.' : 'No cell failed or was skipped.'}
          </p>
        ) : (
          <div className="rounded border border-line overflow-hidden cl-type-data">
            <div className="grid items-center px-3 py-1.5 cl-rubric border-b border-line" style={{ gridTemplateColumns: cols }}>
              <span>Spec file</span>
              {atoms.map((atom) => <span key={atom} className="text-center">{ATOM_LABEL[atom]}</span>)}
            </div>
            {files.map((file) => (
              <div key={file} data-testid="robustness-matrix-row" className="grid items-center px-3 py-1.5 border-t border-line-subtle" style={{ gridTemplateColumns: cols }}>
                <span className="min-w-0 truncate font-mono" title={file}>{file}</span>
                {atoms.map((atom) => {
                  const c = cellFor(file, atom)
                  return <MatrixCell key={atom} state={c.state} title={c.title} testId={`robustness-cell-${atom}`} />
                })}
              </div>
            ))}
          </div>
        )}
        {job.skipped.length > 0 && (
          <ul data-testid="robustness-skipped" className="m-0 mt-2 list-none p-0 cl-type-meta text-secondary">
            {job.skipped.map((s) => (
              <li key={`${s.cell.specFile}:${s.cell.atom}`} className="truncate" title={s.reason}>
                <span className="font-mono">{s.cell.specFile}</span> · {ATOM_LABEL[s.cell.atom]} — not judged: {s.reason}
              </li>
            ))}
          </ul>
        )}
        <p data-testid="robustness-matrix-footer" className="m-0 mt-2 cl-type-meta text-muted">
          {running
            ? `${job.cells.done} of ${plural(job.cells.planned, 'cell')} run so far`
            : `${clean} of ${plural(job.cells.planned, 'cell')} held — a clean cell leaves no record`}
        </p>
      </PanelCard>
    </StageColumn>
  )
}

/** One card per finding, danger-toned: what broke, under what, and the action.
 *  Renders nothing for a matrix with no findings — the state line and the band
 *  already say so, and an empty "Findings" card would be a second way to say it. */
export function RobustnessFindingsPanel({ job, awaiting, onSendToRepair, sending }: {
  job: RobustnessJobManifest | null
  awaiting?: AwaitingState
  /** Start a run under the finding's smallest failing envelope. Absent when the
   *  pane has no run-start path (a read-only external flight). */
  onSendToRepair?: (finding: RobustnessFinding) => void
  /** The finding (by `robustnessFindingKey`) whose run is being started right
   *  now, so its button reads busy and a second click cannot start a second run. */
  sending?: string | null
}) {
  if (!job) {
    return awaiting ? <StageColumn><SkeletonPanel kicker="Findings" awaiting={awaiting} testId="robustness-findings-skeleton" rows={3} /></StageColumn> : null
  }
  if (job.findings.length === 0) return null
  return (
    <>
      {job.findings.map((finding) => (
        <FindingCard
          key={robustnessFindingKey(finding)}
          finding={finding}
          onSendToRepair={onSendToRepair}
          sending={sending === robustnessFindingKey(finding)}
        />
      ))}
    </>
  )
}

function FindingCard({ finding, onSendToRepair, sending }: {
  finding: RobustnessFinding
  onSendToRepair?: (finding: RobustnessFinding) => void
  sending: boolean
}) {
  const [traceOpen, setTraceOpen] = useState(false)
  const settled = finding.status === 'confirmed' || finding.status === 'unconfirmed'
  // The envelope the action sends: the shrunk one once shrink has spoken, else
  // the cell's own — the same thing the finding's repro line describes.
  const shrink = finding.shrink
  const envelope = shrink?.envelope ?? finding.envelope
  const repro = finding.repro ?? shrink?.repro ?? reproLine(envelope)
  return (
    <section
      data-testid="robustness-finding"
      data-status={finding.status}
      className={`flex flex-col gap-2 ${panelCardClass('danger')} ${STAGE_COLUMN}`}
      style={panelCardStyle('danger')}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="text-danger">✕</span>
        <span className="min-w-0 truncate cl-type-title text-danger" title={finding.cell.specFile}>
          <span className="font-mono">{finding.cell.specFile}</span> · {ATOM_LABEL[finding.cell.atom]}
        </span>
        <span data-testid="robustness-finding-status" className="ml-auto shrink-0 cl-type-meta text-secondary">{findingStatusLabel(finding)}</span>
      </div>
      <ul data-testid="robustness-finding-tests" className="m-0 list-none p-0 cl-type-data">
        {finding.failedTests.map((title) => <li key={title} className="truncate" title={title}>{title}</li>)}
      </ul>
      {finding.requirements.length > 0 && (
        <div data-testid="robustness-finding-requirements" className="flex flex-wrap gap-1 cl-type-meta text-muted font-mono">
          {finding.requirements.map((req) => <span key={req}>{req}</span>)}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2 border-t border-line pt-2">
        <div className="min-w-0 flex-1">
          <div className="cl-rubric">{settled ? 'Smallest envelope that still fails' : 'Envelope it failed under'}</div>
          <div data-testid="robustness-finding-repro" className="truncate cl-type-data font-mono" title={repro}>{repro}</div>
        </div>
        {onSendToRepair && settled && (
          <button
            type="button"
            data-testid="robustness-send-to-repair"
            disabled={sending}
            onClick={() => onSendToRepair(finding)}
            className="cl-button min-h-6 shrink-0 px-2 py-0.5"
            title="Start a test run under this envelope so the repair agent works on a failure that reproduces"
          >
            {sending ? 'Starting…' : 'Send to repair'}
          </button>
        )}
      </div>
      {shrink && shrink.steps.length > 0 && (
        <div>
          <button
            type="button"
            data-testid="robustness-trace-toggle"
            onClick={() => setTraceOpen((open) => !open)}
            className="cl-button min-h-6 px-2 py-0.5"
            aria-expanded={traceOpen}
          >
            {traceOpen ? 'Hide' : 'Show'} shrink trace — {plural(shrink.probes, 'probe')}{shrink.budgetExhausted ? ', budget exhausted' : ''}
          </button>
          {traceOpen && (
            <ol data-testid="robustness-trace" className="m-0 mt-1.5 list-none p-0 cl-type-meta text-secondary">
              {shrink.steps.map((step) => (
                <li key={step.probe} className="flex min-w-0 items-baseline gap-2 py-0.5">
                  <span className="shrink-0 font-mono text-muted">{step.probe === 0 ? 'check' : `#${step.probe}`}</span>
                  <span className="min-w-0 flex-1 truncate" title={`${step.why} — ${reproLine(step.envelope)}`}>{step.why}</span>
                  <span className={`shrink-0 ${step.reproduced ? 'text-danger' : 'text-muted'}`}>{step.reproduced ? 'reproduced' : 'held'}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}
