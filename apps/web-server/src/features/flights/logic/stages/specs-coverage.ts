import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { computeFeatureCoverage, LEGACY_MAPPINGS_JSON, runCoverageEngine } from '../../../coverage/logic/coverage/service'
import { COVERAGE_STATE_JSON } from '../../../coverage/logic/coverage/run-state'
import { readPrdSummary } from '../../../coverage/logic/coverage/prd-summary'
import { applyExternalDraftFiles } from '../../../config/logic/feature-authoring'
import { listPlaywrightTests } from '../../../runs/logic/playwright-list'
import { writeWorkflowAgentRef } from '../../../agent-sessions/logic/agent-session-log'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import { renderPrompt } from '../../../../shared/prompts'
import type { CoverageLedger } from '../../../../../../../shared/coverage/types'
import type { SpecsCoveragePass, SpecsCoverageProgress } from '../../../../../../../shared/flights/types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { defaultSpawnAgent, featureDirFor, type FlightSpecsValidator, type FlightStageDeps } from './context'
import { externalWorkCheckpoint, handsOffToClient, parkedOnExternalWork } from './externalizable'
import { agentProgressSink } from './agent-progress'

// The specs↔coverage loop: the agent edits <featureDir>/e2e/*.spec.ts in place
// (Read/Write/Edit tools — no JSON proposal), the existing draft-apply
// validation re-reads and gates what landed on disk, a deterministic dry-run
// (playwright --list + tsc --noEmit) catches specs that don't compile, then
// the coverage engine maps them and the ledger is recomputed — repeating until
// the harness-computed coverage meets the target (default 100% — no untested /
// path-incomplete / variant-incomplete). Validation errors feed the NEXT
// iteration's prompt so the agent repairs broken specs instead of the loop
// silently burning rounds. Bounded: when the loop can't close the remaining
// gaps it parks on coverage-stuck instead of spinning.

const MAX_ITERATIONS = 5
/** Cap on validation-error text injected into the next prompt. */
const MAX_VALIDATION_ERROR_CHARS = 4 * 1024
const PLAYWRIGHT_LIST_TIMEOUT_MS = 60_000
const TSC_TIMEOUT_MS = 120_000

interface GapRow {
  id: string
  title: string
  gap: string
}

function gapRows(ledger: CoverageLedger): GapRow[] {
  return ledger.requirements
    .filter((r) => r.gapType !== 'covered')
    .map((r) => ({ id: r.requirement.id, title: r.requirement.title, gap: r.gapType }))
}

function targetMet(ledger: CoverageLedger, target: number): boolean {
  return ledger.coveragePct >= target
}

function ledgerEvidence(ledger: CoverageLedger): unknown {
  return { coveragePct: ledger.coveragePct, totals: ledger.totals, gaps: gapRows(ledger) }
}

export function buildSpecsPrompt(args: {
  feature: string
  description: string
  /** Absolute path of the feature's config — the agent reads it for port slots. */
  configPath: string
  requirements: unknown
  gaps: GapRow[]
  /** Absolute feature dir — the agent edits <featureDir>/e2e/*.spec.ts in place. */
  featureDir: string
  iteration: number
  /** Compile/list errors from the previous iteration; '' when it validated clean. */
  validationErrors?: string
}): string {
  const errors = (args.validationErrors ?? '').trim()
  return renderPrompt('specs-coverage.md', {
    feature: args.feature,
    description: args.description,
    configPath: args.configPath,
    requirements: JSON.stringify(args.requirements, null, 1),
    iterationNote: args.iteration > 1 ? ` (iteration ${args.iteration} — previous specs did not close these)` : '',
    gaps: JSON.stringify(args.gaps, null, 1),
    featureDir: args.featureDir,
    validationErrors: errors
      ? [
          'The previous iteration\'s specs failed to compile/list — fix these errors before adding coverage:',
          '```',
          errors.slice(0, MAX_VALIDATION_ERROR_CHARS),
          '```',
        ].join('\n')
      : '',
  })
}

/** Run `tsc --noEmit` at the workspace root (where the scaffolded tsconfig
 *  lives) and keep only errors whose file paths fall under `featureDir` — a
 *  user's pre-existing project errors must not fail spec validation. Returns
 *  null when clean, when no tsconfig exists, when tsc isn't installed, or
 *  when it hangs past `timeoutMs` — a missing/stuck tool is not a spec
 *  failure. `timeoutMs` defaults to `TSC_TIMEOUT_MS`; exposed for tests that
 *  need to exercise the timeout without a real 2-minute wait. */
export function tscErrorsForFeature(projectRoot: string, featureDir: string, timeoutMs: number = TSC_TIMEOUT_MS): Promise<string | null> {
  if (!fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) return Promise.resolve(null)
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn('npx', ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'], { cwd: projectRoot })
    // No `if (settled) return` guard here: the close/error handlers below
    // both call clearTimeout synchronously as soon as they set `settled`, so
    // by the time this callback fires, neither has run yet.
    const timer = setTimeout(() => {
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve(null)
    }, timeoutMs)
    child.stdout.on('data', (b) => { out += b.toString() })
    child.stderr.on('data', (b) => { out += b.toString() })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) return resolve(null)
      const lines = out.split('\n').filter((line) => {
        const m = line.match(/^(.+?)\(\d+,\d+\): error TS/)
        if (!m) return false
        const abs = path.resolve(projectRoot, m[1])
        return abs === featureDir || abs.startsWith(featureDir + path.sep)
      })
      resolve(lines.length > 0 ? `tsc --noEmit:\n${lines.join('\n')}` : null)
    })
  })
}

/** Deterministic dry-run over the authored specs: `playwright test --list`
 *  (the existing runs helper — compiles the spec modules, surfacing syntax /
 *  import errors fast) plus feature-scoped `tsc --noEmit`. */
export const defaultValidateSpecs: FlightSpecsValidator = async ({ featureDir, projectRoot }) => {
  const problems: string[] = []
  let listDiagnostics = ''
  const entries = await listPlaywrightTests(featureDir, {
    timeoutMs: PLAYWRIGHT_LIST_TIMEOUT_MS,
    onDiagnostics: (text) => { listDiagnostics += text },
  })
  if (entries === null) {
    // listPlaywrightTests calls onDiagnostics with real content on every path
    // that returns null (timeout, spawn error, non-zero exit, bad JSON).
    problems.push(listDiagnostics.trim())
  }
  const tscErrors = await tscErrorsForFeature(projectRoot, featureDir)
  if (tscErrors) problems.push(tscErrors)
  if (problems.length > 0) return { ok: false, errors: problems.join('\n\n') }
  return { ok: true }
}

export function specsCoverageStage(deps: FlightStageDeps): StageAdapter {
  const spawnAgent = deps.spawnAgent ?? defaultSpawnAgent
  const validateSpecs = deps.validateSpecs ?? defaultValidateSpecs

  const computeImpl = deps.coverage?.compute ?? computeFeatureCoverage
  const runEngine = deps.coverage?.runEngine ?? runCoverageEngine
  const compute = (feature: string): CoverageLedger =>
    computeImpl({ featuresDir: deps.featuresDir, logsDir: deps.logsDir, feature })

  /** State carried from one authoring pass to the next. When the flight hands
   *  authoring to an external client this rides on the checkpoint, which is why
   *  it is a plain serialisable record rather than closure variables. */
  interface PassState {
    iteration: number
    validationErrors: string
    passes: SpecsCoveragePass[]
  }

  const FIRST_PASS: PassState = { iteration: 1, validationErrors: '', passes: [] }

  type Prep =
    | { ok: true; featureDir: string; target: number; requirements: ReturnType<typeof requirementRows> }
    | { ok: false; outcome: StageOutcome }

  function requirementRows(summary: NonNullable<ReturnType<typeof readPrdSummary>>) {
    return summary.requirements
      .filter((r) => !r.deprecated)
      .map((r) => ({ id: r.id, title: r.title, text: r.text, pathTypes: r.pathTypes, variants: r.variants }))
  }

  /** Re-read per entry rather than captured once: a flight parked on an external
   *  hand-off can have its PRD summary edited before the client responds. */
  const prepare = (ctx: StageContext): Prep => {
    const m = ctx.manifest()
    const featureDir = featureDirFor(deps, m.feature)
    const summary = readPrdSummary(featureDir)
    if (!summary) return { ok: false, outcome: { kind: 'failed', error: 'no PRD summary — the prd-summary stage must settle first' } }
    return { ok: true, featureDir, target: m.opts.coverageTarget, requirements: requirementRows(summary) }
  }

  // The loop's structured live shape (R27): every sub-phase transition is
  // published via ctx.setProgress so the flight view renders the
  // authoring↔mapping loop instead of parsing log text.
  const publishProgress = (
    ctx: StageContext,
    ledger: CoverageLedger,
    target: number,
    state: PassState,
    phase: SpecsCoverageProgress['phase'],
  ): void => {
    ctx.setProgress({
      pass: state.iteration,
      maxPasses: MAX_ITERATIONS,
      phase,
      coveragePct: ledger.coveragePct,
      target,
      gapsOpen: gapRows(ledger).length,
      passes: [...state.passes],
    } satisfies SpecsCoverageProgress)
  }

  /** Validate → dry-run → map → recompute: the half of a pass that runs AFTER the
   *  specs were written, by WHICHEVER producer wrote them. Shared by the local
   *  agent and the external hand-off deliberately — the pass verdict is the
   *  harness-computed ledger plus a real tsc/playwright dry-run, never the
   *  producer's account of what it did. Returns the state the next pass starts
   *  from; a rejected or non-compiling batch burns an iteration exactly as before. */
  const afterAuthoring = async (
    ctx: StageContext,
    prep: Extract<Prep, { ok: true }>,
    state: PassState,
    ledger: CoverageLedger,
  ): Promise<{ state: PassState; ledger: CoverageLedger }> => {
    const m = ctx.manifest()
    const bump = (over: Partial<PassState>): PassState => ({
      iteration: state.iteration + 1,
      validationErrors: '',
      passes: state.passes,
      ...over,
    })
    // The producer edited <featureDir>/e2e/*.spec.ts in place; re-read what
    // landed on disk and gate it through the same draft validation as the
    // old JSON-proposal path (fixture import, e2e/ placement, no traversal).
    publishProgress(ctx, ledger, prep.target, state, 'validating')
    const applied = applyExternalDraftFiles({ featureDir: prep.featureDir })
    if (!applied.ok) {
      ctx.appendLog(`[specs] spec files rejected: ${applied.error}\n`)
      return { ledger, state: bump({ validationErrors: applied.error, passes: [...state.passes, { pass: state.iteration, note: 'spec files rejected' }] }) }
    }
    ctx.appendLog(`[specs] validated ${applied.written.length} file(s)\n`)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: m.feature })

    // Deterministic dry-run: specs that don't compile/list can't raise
    // coverage — skip the mapping agent, keep the ledger current, and feed
    // the errors into the next iteration's prompt instead of hard-aborting.
    const dryRun = await validateSpecs({ featureDir: prep.featureDir, projectRoot: deps.projectRoot })
    if (!dryRun.ok) {
      ctx.appendLog(`[specs] dry-run validation failed:\n${dryRun.errors.slice(0, MAX_VALIDATION_ERROR_CHARS)}\n`)
      return {
        ledger: compute(m.feature),
        state: bump({ validationErrors: dryRun.errors, passes: [...state.passes, { pass: state.iteration, note: 'specs failed to compile/list' }] }),
      }
    }

    publishProgress(ctx, ledger, prep.target, state, 'mapping')
    // The mapping half stays a local engine spawn even under an external
    // stageProducer: it is a DIFFERENT agent job with its own standalone
    // hand-off (start_external_coverage), and nesting a second hand-off inside
    // this one would need two parked checkpoints on a single stage.
    await runEngine({
      featuresDir: deps.featuresDir,
      logsDir: deps.logsDir,
      feature: m.feature,
      adapter: m.opts.agent,
      cwd: deps.projectRoot,
      onOutput: agentProgressSink(ctx),
      onAgentSession: (session) => {
        writeWorkflowAgentRef(path.join(ctx.flightDir, 'coverage-map'), {
          agent: session.agent,
          cwd: deps.projectRoot,
          spawnedAt: new Date().toISOString(),
          sessionId: session.sessionId,
        })
      },
    })
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    const mapped = compute(m.feature)
    const next = bump({ passes: [...state.passes, { pass: state.iteration, coveragePct: mapped.coveragePct, gapsOpen: gapRows(mapped).length }] })
    // Settle the pass in the published shape (phase stays 'mapping' — the next
    // pass head flips it to 'authoring' if another one starts).
    publishProgress(ctx, mapped, prep.target, { ...state, passes: next.passes }, 'mapping')
    return { state: next, ledger: mapped }
  }

  /** One authoring pass, then recurse. Expressed recursively rather than as a
   *  `for` loop so the external hand-off can park mid-loop and its responder can
   *  resume the SAME function with the carried state — one control flow for both
   *  producers instead of a duplicated state machine. Depth is bounded by
   *  MAX_ITERATIONS. */
  const runPass = async (
    ctx: StageContext,
    state: PassState,
    ledger: CoverageLedger,
    forceInternal = false,
  ): Promise<StageOutcome> => {
    const prep = prepare(ctx)
    if (!prep.ok) return prep.outcome
    const m = ctx.manifest()
    if (targetMet(ledger, prep.target)) return { kind: 'done', evidence: ledgerEvidence(ledger) }
    if (state.iteration > MAX_ITERATIONS) {
      return {
        kind: 'checkpoint',
        checkpoint: {
          kind: 'coverage-stuck',
          message: `After ${MAX_ITERATIONS} authoring rounds coverage is ${ledger.coveragePct}% (target ${prep.target}%). Accept the remaining gaps or run another round.`,
          options: ['accept-partial', 'retry'],
          data: ledgerEvidence(ledger),
        },
      }
    }

    ctx.appendLog(`[specs] iteration ${state.iteration}: ${ledger.coveragePct}% / ${prep.target}% — ${gapRows(ledger).length} gap(s)\n`)
    publishProgress(ctx, ledger, prep.target, state, 'authoring')
    const prompt = buildSpecsPrompt({
      feature: m.feature,
      description: m.description,
      configPath: path.join(prep.featureDir, 'feature.config.cjs'),
      requirements: prep.requirements,
      gaps: gapRows(ledger),
      featureDir: prep.featureDir,
      iteration: state.iteration,
      validationErrors: state.validationErrors,
    })

    if (!forceInternal && handsOffToClient(ctx)) {
      ctx.appendLog(`[specs] iteration ${state.iteration} handed off to the external client\n`)
      return externalWorkCheckpoint(ctx, 'specs-coverage', prompt, {
        message: `Write the spec files for pass ${state.iteration} in your own client (under ${prep.featureDir}/e2e), then respond. Canary re-reads what landed on disk, compiles it, and recomputes the ledger.`,
        context: { pass: state, featureDir: prep.featureDir, gaps: gapRows(ledger), target: prep.target },
      })
    }

    await spawnAgent({
      prompt,
      cwd: deps.projectRoot,
      // One stable sidecar dir per stage — each iteration re-pins the ref so
      // the flight view's AgentSessionView follows the newest spawn.
      stageDir: path.join(ctx.flightDir, 'specs-coverage'),
      onChunk: agentProgressSink(ctx),
      signal: ctx.signal,
      agent: m.opts.agent,
    })
    const done = await afterAuthoring(ctx, prep, state, ledger)
    return runPass(ctx, done.state, done.ledger)
  }

  // ONE compute on entry; every later ledger is threaded from the point the
  // original loop recomputed (dry-run failure, post-mapping). Pinned by
  // stages.specs-coverage.validate.test.ts, which counts compute() calls.
  const loop = (ctx: StageContext): Promise<StageOutcome> => runPass(ctx, FIRST_PASS, compute(ctx.manifest().feature))

  return {
    run: loop,
    async onCheckpointResponse(ctx, response) {
      // Releasing an authoring hand-off, not the coverage-stuck park. Resume the
      // pass the client was given — its number and accumulated notes ride on the
      // checkpoint, so a restart or a reconnect loses nothing.
      if (parkedOnExternalWork(ctx, 'specs-coverage')) {
        const prep = prepare(ctx)
        if (!prep.ok) return prep.outcome
        const handOff = ctx.manifest().stages.find((s) => s.key === 'specs-coverage')?.checkpoint?.data as
          | { pass?: PassState }
          | undefined
        const state = handOff?.pass ?? FIRST_PASS
        // Fresh compute on resume, unlike the threaded in-loop path: the client
        // has been writing to disk since the hand-off, so a carried ledger would
        // be stale by exactly the work we are here to measure.
        const resumed = compute(ctx.manifest().feature)
        if (response.choice === 'run-internally') {
          ctx.appendLog(`[specs] client handed pass ${state.iteration} back — authoring here\n`)
          return runPass(ctx, state, resumed, true)
        }
        // No branch on response.data: whether the pass advanced coverage is
        // decided by re-reading the specs off disk and recomputing the ledger.
        const done = await afterAuthoring(ctx, prep, state, resumed)
        return runPass(ctx, done.state, done.ledger)
      }
      if (response.choice === 'accept-partial') {
        const ledger = compute(ctx.manifest().feature)
        return { kind: 'done', evidence: { ...(ledgerEvidence(ledger) as object), acceptedPartial: true } }
      }
      return loop(ctx)
    },
    // R78 restart wipe: every spec goes — the scaffold's seed spec included,
    // re-running authoring regenerates it — plus the coverage state the mapping
    // agent produced. The PRD summary is the PREVIOUS stage's artifact and
    // survives a restart that enters here.
    async reset(ctx) {
      const m = ctx.manifest()
      const featureDir = featureDirFor(deps, m.feature)
      if (!fs.existsSync(featureDir)) return
      const e2eDir = path.join(featureDir, 'e2e')
      let wipedSpecs = false
      if (fs.existsSync(e2eDir)) {
        for (const entry of fs.readdirSync(e2eDir)) {
          if (!entry.endsWith('.spec.ts')) continue
          fs.rmSync(path.join(e2eDir, entry), { force: true })
          wipedSpecs = true
        }
      }
      const docsDir = path.join(featureDir, 'docs')
      for (const name of [COVERAGE_STATE_JSON, LEGACY_MAPPINGS_JSON]) {
        fs.rmSync(path.join(docsDir, name), { force: true })
      }
      if (wipedSpecs) publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: m.feature })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    },
  }
}
