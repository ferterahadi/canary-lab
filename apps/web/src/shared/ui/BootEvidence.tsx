import { COMPILER_FAILURE_NEXT_ACTION, runBootPhase, type RunBootFailure } from '@shared/run-state'

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

/** A build that never compiled, whichever producer noticed: the watch-compiler
 *  detector (`compiler-failed`) or the readiness timeout's excerpt classifier. */
function isCompilerFailure(failure: Pick<RunBootFailure, 'reason' | 'classification'>): boolean {
  return failure.reason === 'compiler-failed' || failure.classification === 'compiler-failure'
}

/** The first-reading sentence. Raw reason/classification stays in diagnostics.
 *  Compiler evidence names the headline over the reason: a watcher that failed
 *  its build stays alive, so its reason reads as a timeout. */
export function bootFailureSummary(failure: Pick<RunBootFailure, 'reason' | 'classification'>): string {
  if (isCompilerFailure(failure)) return 'Service build failed before it became ready.'
  if (failure.reason === 'spawn-failed') return 'Service could not be started.'
  if (failure.reason === 'process-exited') return 'Service exited before becoming ready.'
  if (failure.reason === 'health-timeout') return 'Service did not become ready before the timeout.'
  return 'Startup was blocked by incompatible dependencies.'
}

/** The next step to show. Derived on read for compiler evidence so a record
 *  written before readiness advice consulted the evidence reads the same as a
 *  fresh one. */
export function bootNextAction(failure: Pick<RunBootFailure, 'reason' | 'classification' | 'nextAction'>): string | undefined {
  return isCompilerFailure(failure) ? COMPILER_FAILURE_NEXT_ACTION : failure.nextAction
}

export interface CompilerError {
  /** As the compiler printed it, minus a leading `./`. */
  file: string
  line: number
  column: number
  /** `TS2345` and friends, when the compiler names one. */
  code?: string
  message: string
}

// The three shapes TypeScript errors reach a service log in: webpack's
// `ERROR in <file>:<line>:<col>` header over the message, and tsc's own
// `<file>:<line>:<col> - error TS…` and `<file>(<line>,<col>): error TS…`.
const WEBPACK_HEADER = /^ERROR in (\S+?):(\d+):(\d+)\s*$/
const TSC_INLINE = /^(\S+?)(?::(\d+):(\d+) - |\((\d+),(\d+)\): )error (TS\d+): (.+)$/
const CODE_PREFIX = /^(TS\d+):\s*(.*)$/
// A line that ends a webpack message: blank, a code-frame row, or the next verdict.
const MESSAGE_END = /^\s*$|^\s*>?\s*\d*\s*\||^ERROR in |^webpack /

/** Every distinct compiler error in a preserved excerpt, in first-seen order.
 *  Watch-mode monorepos rebuild the same failure over and over (and several
 *  watchers share one log), so one location is one row however often it repeats. */
export function compilerErrors(excerpt: string | undefined): CompilerError[] {
  const lines = (excerpt ?? '').split(/\r?\n/)
  const seen = new Map<string, CompilerError>()
  const add = (error: CompilerError) => {
    const key = `${error.file}:${error.line}:${error.column}`
    if (!seen.has(key)) seen.set(key, error)
  }
  lines.forEach((raw, index) => {
    const text = raw.trim()
    const inline = TSC_INLINE.exec(text)
    if (inline) {
      add({ file: inline[1].replace(/^\.\//, ''), line: Number(inline[2] ?? inline[4]), column: Number(inline[3] ?? inline[5]), code: inline[6], message: inline[7] })
      return
    }
    const header = WEBPACK_HEADER.exec(text)
    if (!header) return
    const body: string[] = []
    for (const next of lines.slice(index + 1)) {
      if (MESSAGE_END.test(next)) break
      body.push(next.trim())
    }
    const [first = '', ...rest] = body
    const coded = CODE_PREFIX.exec(first)
    add({
      file: header[1].replace(/^\.\//, ''),
      line: Number(header[2]),
      column: Number(header[3]),
      ...(coded ? { code: coded[1] } : {}),
      message: [coded ? coded[2] : first, ...rest].join(' ').trim(),
    })
  })
  return [...seen.values()]
}

function causeLabel(failure: BootEvidenceFacts): string | null {
  if (failure.classification === 'underlying-cause-not-preserved') return UNPRESERVED_CAUSE
  return failure.classification === 'empty-output' ? 'No underlying cause observed' : null
}

/** The shared evidence grid behind the run overview's boot-failure card and the
 *  flight stage's error panel. `phase` is derived from `reason` rather than read
 *  off the record, so a historical record renders the same as a fresh one. */
export function BootEvidenceRows({ failure }: { failure: BootEvidenceFacts }) {
  const cause = causeLabel(failure)
  return (
    <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1 text-secondary">
      <dt className="cl-rubric">Phase</dt><dd>{runBootPhase(failure.reason)}</dd>
      <dt className="cl-rubric">Evidence</dt><dd className="font-mono">{bootEvidenceLabel(failure)}</dd>
      <dt className="cl-rubric">Process</dt><dd>{bootProcessLabel(failure)}</dd>
      {failure.command && <><dt className="cl-rubric">Command</dt><dd className="break-all font-mono">{failure.command}</dd></>}
      {failure.cwd && <><dt className="cl-rubric">Directory</dt><dd className="break-all font-mono">{failure.cwd}</dd></>}
      {cause && <><dt className="cl-rubric">Cause</dt><dd>{cause}</dd></>}
    </dl>
  )
}
