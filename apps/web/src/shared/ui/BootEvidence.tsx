import { runBootPhase, type RunBootFailure } from '@shared/run-state'

/** The boot-failure facts every surface shows. Structural, so both the run
 *  manifest's `RunBootFailure` and the flight stage's `FlightStageErrorDetail`
 *  satisfy it without either one importing the other's shape. */
export type BootEvidenceFacts = Pick<
  RunBootFailure,
  'reason' | 'classification' | 'command' | 'cwd' | 'exitCode' | 'signal'
>

/** One wording for the product's key new message. It was written three
 *  different ways across three surfaces, which read as three different facts. */
export const UNPRESERVED_CAUSE = 'Underlying cause not preserved by the outer wrapper'

/** What the evidence adds, falling back to the reason when it adds nothing. */
export function bootEvidenceLabel(failure: BootEvidenceFacts): string {
  return failure.classification ?? failure.reason
}

export function bootProcessLabel(failure: BootEvidenceFacts): string {
  if (failure.signal != null) return `signal ${failure.signal}`
  return failure.exitCode != null ? `exit ${failure.exitCode}` : 'not captured'
}

function causeLabel(failure: BootEvidenceFacts): string {
  if (failure.classification === 'underlying-cause-not-preserved') return UNPRESERVED_CAUSE
  return failure.classification === 'empty-output' ? 'No underlying cause observed' : 'Evidence preserved'
}

/** The shared evidence grid behind the run overview's boot-failure card and the
 *  flight stage's error panel. `phase` is derived from `reason` rather than read
 *  off the record, so a historical record renders the same as a fresh one. */
export function BootEvidenceRows({ failure }: { failure: BootEvidenceFacts }) {
  return (
    <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1 text-secondary">
      <dt className="cl-rubric">Phase</dt><dd>{runBootPhase(failure.reason)}</dd>
      <dt className="cl-rubric">Evidence</dt><dd className="font-mono">{bootEvidenceLabel(failure)}</dd>
      <dt className="cl-rubric">Process</dt><dd>{bootProcessLabel(failure)}</dd>
      {failure.command && <><dt className="cl-rubric">Command</dt><dd className="break-all font-mono">{failure.command}</dd></>}
      {failure.cwd && <><dt className="cl-rubric">Directory</dt><dd className="break-all font-mono">{failure.cwd}</dd></>}
      <dt className="cl-rubric">Cause</dt><dd>{causeLabel(failure)}</dd>
    </dl>
  )
}
