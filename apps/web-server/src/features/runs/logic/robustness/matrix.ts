import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { ROBUSTNESS_ENVELOPE_FORMAT, type RobustnessAtomKind, type RobustnessEnvelope } from '../../../../../../../shared/robustness/types'
import { reproLine, shrinkEnvelope, type ShrinkOptions } from '../../../../../../../shared/robustness/shrink'
import type { RobustnessCell, RobustnessFinding, RobustnessJobManifest, RobustnessSkippedCell } from '../../../../../../../shared/robustness/jobs'
import { testRequirementsReader } from '../dirty-specs/test-requirements'
import { readRunSummary, type RunSummary } from '../run-detail'
import { readManifest } from '../runtime/manifest'
import { buildRunPaths, runDirFor } from '../runtime/run-paths'
import { grepForKnownTests, knownTestsFromSummary, passedNameSet, specFileOfKnownTest, testListForKnownTests, type KnownSummaryTest, type PlaywrightRerunSelection } from '../runtime/rerun-targets'
import type { RobustnessCellResult, RobustnessCellRunner } from './cell-runner'
import type { RobustnessJobRunStore } from './store'

// The Robustness Lab matrix (D16): every spec file of a GREEN run, each booted
// under ONE atom of the suite's envelope, one cell at a time. A cell is a spec
// file rather than a test because the atoms count traffic — the duplicate
// replays the FIRST matching request, the restart fires on the Nth — so the
// file, not the whole suite, must be what meets the perturbation; and a spec
// file is also the unit a serial group lives in, so whole-file cells never
// split one (the targeted-rerun path's own rule).
//
// What comes out is FINDINGS, never counts: a cell whose tests all pass leaves
// no record, a cell with failures becomes one finding naming the tests and the
// `@requirement` ids they carry, and a cell whose run produced no verdict is
// listed as skipped — so the certificate can say what was NOT proven. The green
// run's own verdict is never read for anything but its inventory.
//
// Once the matrix has run, every finding is SHRUNK (`shared/robustness/shrink`):
// the same cell is replayed under smaller envelopes until the smallest one that
// still fails the same test is known, then replayed three times. What the human
// (or the repair agent) reads is that one-line repro; a finding whose replays
// disagree stays in the list as `unconfirmed` with its trace.

export class RobustnessJobConflictError extends Error {
  readonly statusCode = 409
  constructor(public readonly feature: string, public readonly existingJobId: string) {
    super(`a robustness job is already running for ${feature}`)
    this.name = 'RobustnessJobConflictError'
  }
}

export interface StartRobustnessJobArgs {
  logsDir: string
  feature: string
  /** The green run whose inventory (spec files, test titles, `env`) the matrix is built from. */
  runId: string
  envelope: RobustnessEnvelope
}

/** Thrown inside the driver when `abortRobustnessJob` fires between cells; the
 *  catch below turns it into `status: 'aborted'` rather than `failed`. */
class RobustnessJobAbortedError extends Error {
  constructor() {
    super('aborted')
    this.name = 'RobustnessJobAbortedError'
  }
}

/** The in-flight drivers of THIS process, by job id. In-memory by design: a job
 *  left `running` by a dead process has no driver to stop and the store's boot
 *  reconcile already marks it `aborted`. */
const ACTIVE_JOBS = new Map<string, AbortController>()

/** Stop a running job: the current cell's run is aborted through the run store
 *  and the driver settles the record as `aborted` instead of starting the next
 *  cell or probe. False when no driver in this process owns the id — the job
 *  already settled, or it belongs to another (dead) server. */
export function abortRobustnessJob(jobId: string): boolean {
  const controller = ACTIVE_JOBS.get(jobId)
  if (!controller) return false
  controller.abort()
  return true
}

export interface RobustnessJobRunnerDeps {
  store: RobustnessJobRunStore
  runCell: RobustnessCellRunner
  /** Shrink budget and resolution; the shared defaults (12 probes, 3 replays, 50 ms) unless a test narrows them. */
  shrink?: ShrinkOptions
  now?: () => string
  newJobId?: () => string
}

export interface StartRobustnessJobResult {
  manifest: RobustnessJobManifest
  /** Resolves when the matrix has run (used by tests; REST and MCP return at once). */
  completion: Promise<void>
}

export interface PlannedCell {
  cell: RobustnessCell
  /** The one-atom envelope this cell boots under, at the atom's declared knobs. */
  envelope: RobustnessEnvelope
  selection: PlaywrightRerunSelection
  tests: KnownSummaryTest[]
}

/** A finding together with the cell it came from, so shrink can replay it. */
interface FoundCell {
  planned: PlannedCell
  finding: RobustnessFinding
  /** Names (not titles) of the failed tests — what a replay's summary is matched on. */
  failedNames: Set<string>
}

export interface RobustnessMatrixPlan {
  cells: PlannedCell[]
  /** The suite folder the green run executed — where cell paths are relative to
   *  and where `@requirement` tags are read from. */
  suiteDir: string
  env?: string
  /** Test names the green run passed: a cell failure counts only against these. */
  greenPassed: Set<string>
}

/** Splits an envelope into its atoms, each as a one-atom envelope. Every
 *  restart schedule travels together: "restart" is one kind of perturbation
 *  however many slots it names. */
export function envelopeAtoms(envelope: RobustnessEnvelope): Array<{ atom: RobustnessAtomKind; envelope: RobustnessEnvelope }> {
  const atoms: Array<{ atom: RobustnessAtomKind; envelope: RobustnessEnvelope }> = []
  if (envelope.latency) atoms.push({ atom: 'latency', envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: envelope.latency } })
  if (envelope.duplicate) atoms.push({ atom: 'duplicate', envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, duplicate: envelope.duplicate } })
  if (envelope.restart && envelope.restart.length > 0) atoms.push({ atom: 'restart', envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, restart: envelope.restart } })
  return atoms
}

/** Lays the matrix out from the green run's record. Throws — rather than
 *  planning a partial matrix — when the run cannot supply an inventory: no
 *  summary, a summary from before the reporter recorded locations, a run whose
 *  suite folder is gone, or an envelope with nothing in it. */
export function planRobustnessMatrix(logsDir: string, runId: string, envelope: RobustnessEnvelope): RobustnessMatrixPlan {
  const atoms = envelopeAtoms(envelope)
  if (atoms.length === 0) throw new Error('the robustness envelope declares no atom — nothing to perturb')
  const runDir = runDirFor(logsDir, runId)
  const summary = readRunSummary(runDir)
  const known = summary ? knownTestsFromSummary(summary) : []
  if (!summary || known.length === 0) throw new Error(`run ${runId} has no test inventory to build the matrix from`)
  const manifest = readManifest(path.join(runDir, 'manifest.json'))
  const snapshotDir = buildRunPaths(runDir).suiteSnapshotDir
  const suiteDir = fs.existsSync(snapshotDir) ? snapshotDir : manifest?.featureDir
  if (!suiteDir) throw new Error(`run ${runId} has no suite folder on disk to read specs from`)

  const byFile = new Map<string, KnownSummaryTest[]>()
  for (const test of known) {
    const file = specFileOfKnownTest(test)
    if (!file) throw new Error(`run ${runId} recorded no location for "${test.title}" — run the suite again so every test has one`)
    const rel = path.relative(suiteDir, file)
    byFile.set(rel, [...(byFile.get(rel) ?? []), test])
  }

  const cells: PlannedCell[] = []
  for (const specFile of [...byFile.keys()].sort()) {
    const tests = byFile.get(specFile)!
    for (const { atom, envelope: atomEnvelope } of atoms) {
      cells.push({
        cell: { specFile, atom },
        envelope: atomEnvelope,
        selection: cellSelection(specFile, atom, tests, known.length),
        tests,
      })
    }
  }
  return { cells, suiteDir, env: manifest?.env, greenPassed: passedNameSet(summary) }
}

/** The whole spec file, as a test list when the inventory can name every test
 *  that way (exact), else as a title grep (the pre-`--test-list` fallback). */
function cellSelection(specFile: string, atom: RobustnessAtomKind, tests: KnownSummaryTest[], total: number): PlaywrightRerunSelection {
  const shared = { selected: tests.length, total, mode: 'robustness-cell' as const, reason: `Robustness Lab cell: ${specFile} under ${atom}.` }
  const testList = testListForKnownTests(tests)
  return testList
    ? { kind: 'test-list', testList, ...shared }
    : { kind: 'grep', grep: grepForKnownTests(tests), ...shared }
}

export type CellJudgement =
  | { kind: 'clean' }
  | { kind: 'finding'; finding: RobustnessFinding }
  | { kind: 'skipped'; skipped: RobustnessSkippedCell }

/** What one cell's run says. A run with no summary, or one that ended without
 *  a failing test yet did not pass (aborted mid-way, a service that never came
 *  up), is a cell the matrix could not judge — skipped, named, never a finding. */
export function judgeCell(planned: PlannedCell, result: RobustnessCellResult, plan: RobustnessMatrixPlan, requirementsOf: (test: KnownSummaryTest) => string[] | undefined): CellJudgement {
  const { cell } = planned
  if (!result.summary) {
    return { kind: 'skipped', skipped: { cell, runId: result.runId, reason: `run ${result.runId} ended ${result.status} without a test summary` } }
  }
  const failedNames = new Set(result.summary.failed.map((entry) => entry.name))
  const failed = planned.tests.filter((test) => failedNames.has(test.name) && plan.greenPassed.has(test.name))
  if (failed.length === 0) {
    if (result.status === 'passed') return { kind: 'clean' }
    return { kind: 'skipped', skipped: { cell, runId: result.runId, reason: `run ${result.runId} ended ${result.status} without a failing test in ${cell.specFile}` } }
  }
  const requirements = new Set<string>()
  for (const test of failed) for (const id of requirementsOf(test) ?? []) requirements.add(id)
  return {
    kind: 'finding',
    finding: {
      cell,
      runId: result.runId,
      failedTests: failed.map((test) => test.title),
      requirements: [...requirements],
      status: 'found',
      envelope: planned.envelope,
    },
  }
}

function defaultJobId(): string {
  return `rj_${crypto.randomBytes(6).toString('hex')}`
}

/** Starts the matrix for a suite as a background job. Planning happens here,
 *  synchronously, so a run that cannot supply an inventory is the caller's
 *  error (a 4xx, not a job record); once planned, the record is `running` with
 *  the cell count the moment this returns, every cell's outcome is saved as it
 *  lands (the store's event is the pane's push), and the job ends `done` — or
 *  `failed` with the reason when a cell could not even be started. One job per
 *  suite at a time: two matrices would boot the same services against each
 *  other. */
export function startRobustnessJob(args: StartRobustnessJobArgs, deps: RobustnessJobRunnerDeps): StartRobustnessJobResult {
  const now = deps.now ?? (() => new Date().toISOString())
  const { store } = deps
  const active = store.activeFor(args.feature)
  if (active) throw new RobustnessJobConflictError(args.feature, active.jobId)
  const plan = planRobustnessMatrix(args.logsDir, args.runId, args.envelope)
  const files = new Set(plan.cells.map((c) => c.cell.specFile)).size
  const atoms = envelopeAtoms(args.envelope).map((a) => a.atom)

  let manifest: RobustnessJobManifest = {
    jobId: (deps.newJobId ?? defaultJobId)(),
    feature: args.feature,
    runId: args.runId,
    envelope: args.envelope,
    status: 'running',
    startedAt: now(),
    cells: { planned: plan.cells.length, done: 0 },
    findings: [],
    skipped: [],
    log: `matrix from run ${args.runId}: ${plural(files, 'spec file')} × ${plural(atoms.length, 'atom')} (${atoms.join(', ')}) = ${plural(plan.cells.length, 'cell')}\n`,
  }
  store.save(manifest)
  const save = (patch: Partial<RobustnessJobManifest>) => {
    manifest = { ...manifest, ...patch }
    store.save(manifest)
  }
  const append = (line: string, patch: Partial<RobustnessJobManifest> = {}) => save({ ...patch, log: `${manifest.log}${line}\n` })
  const controller = new AbortController()
  ACTIVE_JOBS.set(manifest.jobId, controller)
  const { signal } = controller
  const checkpoint = (): void => {
    if (signal.aborted) throw new RobustnessJobAbortedError()
  }

  const completion = (async () => {
    try {
      const readers = new Map<string, (test: string) => string[] | undefined>()
      const requirementsOf = (specFile: string) => (test: KnownSummaryTest) => {
        let reader = readers.get(specFile)
        if (!reader) {
          reader = testRequirementsReader(specFile, (rel) => readSource(path.join(plan.suiteDir, rel)))
          readers.set(specFile, reader)
        }
        // The reader is keyed by the test's TITLE as written in the source; a
        // summary's `name` is the runner's slug (`test-case-…`) and matches nothing.
        return reader(test.title)
      }
      const found: FoundCell[] = []
      for (const [index, planned] of plan.cells.entries()) {
        checkpoint()
        const label = `cell ${index + 1}/${plan.cells.length} ${planned.cell.specFile} × ${planned.cell.atom}`
        const result = await deps.runCell({ feature: args.feature, env: plan.env, envelope: planned.envelope, selection: planned.selection, signal })
        checkpoint()
        const judged = judgeCell(planned, result, plan, requirementsOf(planned.cell.specFile))
        const done = { planned: plan.cells.length, done: index + 1 }
        if (judged.kind === 'finding') {
          const titles = new Set(judged.finding.failedTests)
          found.push({ planned, finding: judged.finding, failedNames: new Set(planned.tests.filter((t) => titles.has(t.title)).map((t) => t.name)) })
          append(`${label}: FINDING — ${judged.finding.failedTests.join(' | ')} (run ${result.runId})`, { cells: done, findings: [...manifest.findings, judged.finding] })
        } else if (judged.kind === 'skipped') {
          append(`${label}: skipped — ${judged.skipped.reason}`, { cells: done, skipped: [...manifest.skipped, judged.skipped] })
        } else {
          append(`${label}: clean (run ${result.runId})`, { cells: done })
        }
      }

      // Shrink after the whole matrix, not per finding: the matrix is the
      // cheap, complete answer ("where does it break"); shrink spends up to
      // sixteen more runs per finding on "how little does it take".
      for (const [index, item] of found.entries()) {
        const { cell } = item.finding
        const label = `shrink ${index + 1}/${found.length} ${cell.specFile} × ${cell.atom}`
        const patchFinding = (patch: Partial<RobustnessFinding>) => ({ findings: manifest.findings.map((f) => (sameCell(f.cell, cell) ? { ...f, ...patch } : f)) })
        save(patchFinding({ status: 'shrinking' }))
        let probe = 0
        const result = await shrinkEnvelope(item.finding.envelope, async (candidate) => {
          checkpoint()
          const replay = await deps.runCell({ feature: args.feature, env: plan.env, envelope: candidate, selection: item.planned.selection, signal })
          checkpoint()
          const reproduced = replay.summary !== undefined && replay.summary.failed.some((entry) => item.failedNames.has(entry.name))
          append(`${label} probe ${++probe}: ${reproLine(candidate)} → ${reproduced ? 'reproduced' : 'did not reproduce'} (run ${replay.runId})`)
          return reproduced
        }, deps.shrink)
        const status: RobustnessFinding['status'] = result.status === 'confirmed' ? 'confirmed' : 'unconfirmed'
        const verdict = result.status === 'not-reproduced'
          ? 'did not reproduce even once under the envelope it was found with'
          : result.status === 'confirmed'
            ? `confirmed ${result.confirmations.reproduced}/${result.confirmations.asked} → ${result.repro}`
            : `unconfirmed — replayed ${result.confirmations.reproduced}/${result.confirmations.asked} at ${result.repro}`
        append(`${label}: ${verdict} (${result.probes} search probe${result.probes === 1 ? '' : 's'}${result.budgetExhausted ? ', budget exhausted' : ''})`, patchFinding({ status, shrink: result, repro: result.repro }))
      }
      save({ status: 'done', endedAt: now() })
    } catch (err) {
      if (err instanceof RobustnessJobAbortedError) {
        append('aborted — the matrix was stopped before it finished; findings so far stand, nothing after them was judged', { status: 'aborted', endedAt: now(), error: 'Aborted' })
      } else {
        save({ status: 'failed', endedAt: now(), error: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      ACTIVE_JOBS.delete(manifest.jobId)
    }
  })()
  return { manifest, completion }
}

function sameCell(a: RobustnessCell, b: RobustnessCell): boolean {
  return a.specFile === b.specFile && a.atom === b.atom
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function readSource(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return undefined
  }
}

export type { RunSummary }
