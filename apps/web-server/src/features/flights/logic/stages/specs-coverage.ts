import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { applyExternalCoverageMappings, buildCoverageMappingContext, computeFeatureCoverage, LEGACY_MAPPINGS_JSON, runCoverageEngine } from '../../../coverage/logic/coverage/service'
import { IncompleteCoverageAnswerError, missingFromRoster, parseMappingSubmission } from '../../../coverage/logic/coverage/external-submissions'
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
import { decodeSubmission, defaultSpawnAgent, featureDirFor, type FlightSpecsValidator, type FlightStageDeps, stageJobRef } from './context'
import { agentSpawnJob } from './stage-jobs'
import { externalWorkCheckpoint, handsOffToClient, parkedOnExternalWork, rejectStaleSubmit } from './externalizable'
import { agentProgressSink } from './agent-progress'
import { CHECKPOINT_OPTIONS, type FlightCheckpoint } from '../types'

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
//
// Under an external stageProducer BOTH agent jobs hand off, sequentially: the
// authoring park releases into validation, and a validated batch parks a
// second time for the mapping (same prompt + roster the standalone
// start_external_coverage hands out). Only one checkpoint is ever outstanding,
// so the conductor's one-park-per-stage model needs no second slot.

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
    ctx.setTimingPhase?.(phase === 'validating' ? 'validation' : phase)
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

  /** Preserve one immutable ref before the loop's mutable author/map sidecar is
   *  repinned by a later pass. The manifest array is the ordered Activity model;
   *  each entry's directory keeps the existing REST + WebSocket session-tail
   *  paths reusable without teaching either transport a second ref format. */
  const recordAgentSession = (
    ctx: StageContext,
    state: PassState,
    phase: 'authoring' | 'mapping',
    session: { agent: 'claude' | 'codex'; sessionId: string },
    spawnedAt: string,
  ): void => {
    const stage = ctx.manifest().stages.find((candidate) => candidate.key === 'specs-coverage')
    const sequence = (stage?.agentSessions?.length ?? 0) + 1
    const sidecar = `specs-coverage-session-${String(sequence).padStart(3, '0')}`
    const sessionDir = path.join(ctx.flightDir, sidecar)
    writeWorkflowAgentRef(sessionDir, {
      agent: session.agent,
      cwd: deps.projectRoot,
      spawnedAt,
      sessionId: session.sessionId,
    })
    // writeWorkflowAgentRef is deliberately best-effort. Do not persist a
    // pointer the viewer can never resolve when that write failed.
    if (!fs.existsSync(path.join(sessionDir, 'agent-session.json'))) return
    ctx.addAgentSession({
      sidecar,
      label: `Pass ${state.iteration} · ${phase === 'authoring' ? 'Authoring' : 'Mapping'}`,
      startedAt: spawnedAt,
      phase,
      pass: state.iteration,
    })
  }

  const bumpPass = (state: PassState, over: Partial<PassState>): PassState => ({
    iteration: state.iteration + 1,
    validationErrors: '',
    passes: state.passes,
    ...over,
  })

  /** Tags landed (by WHICHEVER mapper) → record the pass off a fresh recompute
   *  and continue the loop. The verdict ledger is the stage's own compute — the
   *  producer's account of what it mapped never reaches a loop decision. */
  const settleMapped = (
    ctx: StageContext,
    prep: Extract<Prep, { ok: true }>,
    state: PassState,
  ): Promise<StageOutcome> => {
    const m = ctx.manifest()
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    const mapped = compute(m.feature)
    const next = bumpPass(state, { passes: [...state.passes, { pass: state.iteration, coveragePct: mapped.coveragePct, gapsOpen: gapRows(mapped).length }] })
    // Settle the pass in the published shape (phase stays 'mapping' — the next
    // pass head flips it to 'authoring' if another one starts).
    publishProgress(ctx, mapped, prep.target, { ...state, passes: next.passes }, 'mapping')
    return runPass(ctx, next, mapped)
  }

  /** The mapping half as a local engine spawn — the internal producer's path,
   *  and the per-step escape hatch when the client hands a mapping back. */
  const mapInternally = async (
    ctx: StageContext,
    prep: Extract<Prep, { ok: true }>,
    state: PassState,
    requirementIds: string[],
  ): Promise<StageOutcome> => {
    const m = ctx.manifest()
    await runEngine({
      featuresDir: deps.featuresDir,
      logsDir: deps.logsDir,
      feature: m.feature,
      requirementIds,
      adapter: m.opts.agent,
      cwd: deps.projectRoot,
      // The mapping half spawns its OWN agent, so it needs the signal as much as
      // the authoring half below. Without it a pause landing in `mapping` left
      // the coverage mapper running until its idle watchdog fired.
      signal: ctx.signal,
      // This stage is the one with TWO spawns, under two sidecar dirs — the
      // authoring half scopes itself to `specs-coverage` via defaultSpawnAgent,
      // and the mapper gets `coverage-map` here. stageSidecarDirs() enumerates
      // both, so a teardown stops whichever half is live.
      spawnScope: path.join(ctx.flightDir, 'coverage-map'),
      agentJob: { record: { jobId: `${m.flightId}:coverage-map`, flightId: m.flightId, feature: m.feature, stage: 'coverage-map', agent: m.opts.agent ?? 'claude' }, logsDir: deps.logsDir },
      onOutput: agentProgressSink(ctx),
      onAgentSession: (session) => {
        const spawnedAt = new Date().toISOString()
        writeWorkflowAgentRef(path.join(ctx.flightDir, 'coverage-map'), {
          agent: session.agent,
          cwd: deps.projectRoot,
          spawnedAt,
          sessionId: session.sessionId,
        })
        recordAgentSession(ctx, state, 'mapping', session, spawnedAt)
      },
    })
    return settleMapped(ctx, prep, state)
  }

  /** Park the mapping half on the client — the stage's SECOND, sequential
   *  hand-off. The authoring park has been consumed by the time this is built,
   *  so only one checkpoint is ever outstanding: the conductor's
   *  one-park-per-stage model holds without a second slot. The roster is pinned
   *  at park time (the standalone job's externalTestRoster rule): the answer is
   *  judged against what the client was HANDED, never a suite that moved while
   *  it worked. */
  const mappingHandOff = (
    ctx: StageContext,
    prep: Extract<Prep, { ok: true }>,
    state: PassState,
    requirementIds: string[],
  ): StageOutcome => {
    const mappingContext = buildCoverageMappingContext({ featuresDir: deps.featuresDir, feature: ctx.manifest().feature, requirementIds })
    ctx.appendLog(`[specs] pass ${state.iteration} mapping handed off to the external client\n`)
    return externalWorkCheckpoint(ctx, 'specs-coverage', mappingContext.prompt, {
      message: `Map the tests onto the requirements in your own client (pass ${state.iteration}), then respond with { mappings[], unmappable[] } on \`data\` — every roster test must appear in one of them. Canary writes the tags itself and recomputes the ledger.`,
      context: { phase: 'mapping', pass: state, roster: mappingContext.tests.map((t) => t.testName), target: prep.target },
    })
  }

  /** Re-park the SAME mapping ask with the rejection reason. The checkpoint is
   *  reused wholesale (rejectStaleSubmit's rule): the roster and prompt were
   *  pinned at hand-off time and the ask has not changed — only the answer fell
   *  short. `lastRejection` rides on data rather than the message so a second
   *  rejection cannot stack prefixes. */
  const reparkMapping = (ctx: StageContext, checkpoint: FlightCheckpoint, why: string): StageOutcome => {
    ctx.appendLog(`[specs] mapping submission rejected — ${why}\n`)
    return { kind: 'checkpoint', checkpoint: { ...checkpoint, data: { ...(checkpoint.data as object), lastRejection: why } } }
  }

  /** Validate → dry-run → map → recompute: the half of a pass that runs AFTER the
   *  specs were written, by WHICHEVER producer wrote them. Shared by the local
   *  agent and the external hand-off deliberately — the pass verdict is the
   *  harness-computed ledger plus a real tsc/playwright dry-run, never the
   *  producer's account of what it did. A rejected or non-compiling batch burns
   *  an iteration exactly as before. `forceInternalMap` rides a whole-pass
   *  take-back (run-internally on an AUTHORING park): the client asked Canary to
   *  run that pass, mapping half included — the NEXT pass hands off again. */
  const afterAuthoring = async (
    ctx: StageContext,
    prep: Extract<Prep, { ok: true }>,
    state: PassState,
    ledger: CoverageLedger,
    forceInternalMap = false,
  ): Promise<StageOutcome> => {
    const m = ctx.manifest()
    // The producer edited <featureDir>/e2e/*.spec.ts in place; re-read what
    // landed on disk and gate it through the same draft validation as the
    // old JSON-proposal path (fixture import, e2e/ placement, no traversal).
    publishProgress(ctx, ledger, prep.target, state, 'validating')
    const applied = applyExternalDraftFiles({ featureDir: prep.featureDir })
    if (!applied.ok) {
      ctx.appendLog(`[specs] spec files rejected: ${applied.error}\n`)
      return runPass(ctx, bumpPass(state, { validationErrors: applied.error, passes: [...state.passes, { pass: state.iteration, note: 'spec files rejected' }] }), ledger)
    }
    ctx.appendLog(`[specs] validated ${applied.written.length} file(s)\n`)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: m.feature })

    // Deterministic dry-run: specs that don't compile/list can't raise
    // coverage — skip the mapping agent, keep the ledger current, and feed
    // the errors into the next iteration's prompt instead of hard-aborting.
    const dryRun = await validateSpecs({ featureDir: prep.featureDir, projectRoot: deps.projectRoot })
    if (!dryRun.ok) {
      ctx.appendLog(`[specs] dry-run validation failed:\n${dryRun.errors.slice(0, MAX_VALIDATION_ERROR_CHARS)}\n`)
      return runPass(
        ctx,
        bumpPass(state, { validationErrors: dryRun.errors, passes: [...state.passes, { pass: state.iteration, note: 'specs failed to compile/list' }] }),
        compute(m.feature),
      )
    }

    // Authoring may have closed some gaps or exposed regressions by rewriting a
    // previously mapped test. Recompute before inference so this pass maps only
    // the requirements that are actually open now. Existing tags for covered
    // requirements stay untouched; the mapper still accounts for every test it
    // receives, and Canary still derives the verdict from the resulting tags.
    const mappingLedger = compute(m.feature)
    const requirementIds = gapRows(mappingLedger).map((gap) => gap.id)
    publishProgress(ctx, mappingLedger, prep.target, state, 'mapping')
    // The mapping half is a DIFFERENT agent job with its own standalone twin
    // (start_external_coverage), so under an external producer it becomes the
    // stage's second sequential hand-off rather than a local spawn.
    if (!forceInternalMap && handsOffToClient(ctx)) return mappingHandOff(ctx, prep, state, requirementIds)
    return mapInternally(ctx, prep, state, requirementIds)
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
          // "passes", not "authoring rounds": the Passes card beside this
          // checkpoint and the live state line both count the same loop in
          // passes — one loop, one word.
          message: `After ${MAX_ITERATIONS} passes, coverage is ${ledger.coveragePct}% (target ${prep.target}%). Accept the gaps that are left, or try another pass.`,
          options: [...CHECKPOINT_OPTIONS['coverage-stuck']],
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
        context: { phase: 'authoring', pass: state, featureDir: prep.featureDir, gaps: gapRows(ledger), target: prep.target },
      })
    }

    await spawnAgent({
      prompt,
      cwd: deps.projectRoot,
      // One stable sidecar dir per stage — each iteration re-pins the ref so
      // the flight view's AgentSessionView follows the newest spawn.
      stageDir: path.join(ctx.flightDir, 'specs-coverage'),
      job: stageJobRef(deps, m, 'specs-coverage'),
      onChunk: agentProgressSink(ctx),
      signal: ctx.signal,
      agent: m.opts.agent,
      onAgentSession: (session) => {
        recordAgentSession(ctx, state, 'authoring', session, session.spawnedAt)
      },
    })
    return afterAuthoring(ctx, prep, state, ledger, forceInternal)
  }

  // ONE compute on entry; every later ledger is threaded from the point the
  // original loop recomputed (dry-run failure, post-mapping). Pinned by
  // stages.specs-coverage.validate.test.ts, which counts compute() calls.
  const loop = (ctx: StageContext): Promise<StageOutcome> => runPass(ctx, FIRST_PASS, compute(ctx.manifest().feature))

  return {
    // BOTH of this stage's agents — the spec author and the coverage mapper —
    // under their two sidecar dirs. Whichever half is live gets stopped.
    teardown: (ctx) => agentSpawnJob(ctx, 'specs-coverage'),
    run: loop,
    async onCheckpointResponse(ctx, response) {
      // Releasing one of this stage's TWO hand-offs (authoring, or the mapping
      // that follows it), not the coverage-stuck park. The pass state and the
      // hand-off's phase ride on the checkpoint's `context`, so a restart or a
      // reconnect loses nothing — read from where the park actually put them
      // (externalWorkCheckpoint nests caller context under `data.context`).
      if (parkedOnExternalWork(ctx, 'specs-coverage')) {
        const prep = prepare(ctx)
        if (!prep.ok) return prep.outcome
        const checkpoint = ctx.manifest().stages.find((s) => s.key === 'specs-coverage')?.checkpoint
        const handOff = (checkpoint?.data as { context?: { phase?: string; pass?: PassState; roster?: string[] } } | undefined)?.context
        const state = handOff?.pass ?? FIRST_PASS

        // A pre-phase park carried no `phase` and can only be an authoring one.
        if (handOff?.phase === 'mapping') {
          if (response.choice === 'run-internally') {
            ctx.appendLog(`[specs] client handed the pass ${state.iteration} mapping back — mapping here\n`)
            const ledger = compute(ctx.manifest().feature)
            return mapInternally(ctx, prep, state, gapRows(ledger).map((gap) => gap.id))
          }
          const stale = rejectStaleSubmit(ctx, 'specs-coverage', response)
          if (stale) return stale
          // Decode before validating: a client that JSON-encodes its answer used
          // to be rejected here for "expected object, received string" while the
          // prd-summary hand-off two stages earlier accepted the same encoding —
          // an external flight could not clear this step at all and had to fall
          // back to run-internally. See decodeSubmission.
          const decoded = decodeSubmission(response.data)
          if (!decoded.ok) return reparkMapping(ctx, checkpoint!, decoded.error)
          const parsed = parseMappingSubmission(decoded.data)
          if (!parsed.ok) return reparkMapping(ctx, checkpoint!, parsed.error)
          const roster = handOff.roster ?? []
          const missing = missingFromRoster(roster, parsed.submission.mappings, parsed.submission.unmappable)
          if (missing.length > 0) {
            return reparkMapping(ctx, checkpoint!, new IncompleteCoverageAnswerError(missing, roster.length).message)
          }
          // Write the tags through the canonical tag-writer (unknown ids / test
          // names dropped) — then the pass verdict is settleMapped's recompute,
          // exactly as it is for the internal mapper.
          applyExternalCoverageMappings({
            featuresDir: deps.featuresDir,
            logsDir: deps.logsDir,
            feature: ctx.manifest().feature,
            mappings: parsed.submission.mappings,
          })
          return settleMapped(ctx, prep, state)
        }

        // Fresh compute on resume, unlike the threaded in-loop path: the client
        // has been writing to disk since the hand-off, so a carried ledger would
        // be stale by exactly the work we are here to measure.
        const resumed = compute(ctx.manifest().feature)
        if (response.choice === 'run-internally') {
          ctx.appendLog(`[specs] client handed pass ${state.iteration} back — authoring here\n`)
          return runPass(ctx, state, resumed, true)
        }
        const stale = rejectStaleSubmit(ctx, 'specs-coverage', response)
        if (stale) return stale
        // No branch on response.data: whether the pass advanced coverage is
        // decided by re-reading the specs off disk and recomputing the ledger.
        return afterAuthoring(ctx, prep, state, resumed)
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
