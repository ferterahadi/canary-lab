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

  const loop = async (ctx: StageContext): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const featureDir = featureDirFor(deps, m.feature)
    const target = m.opts.coverageTarget
    const summary = readPrdSummary(featureDir)
    if (!summary) return { kind: 'failed', error: 'no PRD summary — the prd-summary stage must settle first' }
    const requirements = summary.requirements
      .filter((r) => !r.deprecated)
      .map((r) => ({ id: r.id, title: r.title, text: r.text, pathTypes: r.pathTypes, variants: r.variants }))

    let ledger = compute(m.feature)
    let validationErrors = ''
    // The loop's structured live shape (R27): every sub-phase transition is
    // published via ctx.setProgress so the flight view renders the
    // authoring↔mapping loop instead of parsing log text.
    const passes: SpecsCoveragePass[] = []
    const publish = (pass: number, phase: SpecsCoverageProgress['phase']): void => {
      ctx.setProgress({
        pass,
        maxPasses: MAX_ITERATIONS,
        phase,
        coveragePct: ledger.coveragePct,
        target,
        gapsOpen: gapRows(ledger).length,
        passes: [...passes],
      } satisfies SpecsCoverageProgress)
    }
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      if (targetMet(ledger, target)) {
        return { kind: 'done', evidence: ledgerEvidence(ledger) }
      }
      ctx.appendLog(`[specs] iteration ${iteration}: ${ledger.coveragePct}% / ${target}% — ${gapRows(ledger).length} gap(s)\n`)
      publish(iteration, 'authoring')

      await spawnAgent({
        prompt: buildSpecsPrompt({
          feature: m.feature,
          description: m.description,
          configPath: path.join(featureDir, 'feature.config.cjs'),
          requirements,
          gaps: gapRows(ledger),
          featureDir,
          iteration,
          validationErrors,
        }),
        cwd: deps.projectRoot,
        // One stable sidecar dir per stage — each iteration re-pins the ref so
        // the flight view's AgentSessionView follows the newest spawn.
        stageDir: path.join(ctx.flightDir, 'specs-coverage'),
        onChunk: ctx.appendLog,
        signal: ctx.signal,
        agent: m.opts.agent,
      })
      // The agent edited <featureDir>/e2e/*.spec.ts in place; re-read what
      // landed on disk and gate it through the same draft validation as the
      // old JSON-proposal path (fixture import, e2e/ placement, no traversal).
      publish(iteration, 'validating')
      const applied = applyExternalDraftFiles({ featureDir })
      if (!applied.ok) {
        ctx.appendLog(`[specs] spec files rejected: ${applied.error}\n`)
        validationErrors = applied.error
        passes.push({ pass: iteration, note: 'spec files rejected' })
        continue // burns an iteration; the bound keeps this finite
      }
      ctx.appendLog(`[specs] validated ${applied.written.length} file(s)\n`)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: m.feature })

      // Deterministic dry-run: specs that don't compile/list can't raise
      // coverage — skip the mapping agent, keep the ledger current, and feed
      // the errors into the next iteration's prompt instead of hard-aborting.
      const dryRun = await validateSpecs({ featureDir, projectRoot: deps.projectRoot })
      if (!dryRun.ok) {
        validationErrors = dryRun.errors
        ctx.appendLog(`[specs] dry-run validation failed:\n${dryRun.errors.slice(0, MAX_VALIDATION_ERROR_CHARS)}\n`)
        ledger = compute(m.feature)
        passes.push({ pass: iteration, note: 'specs failed to compile/list' })
        continue
      }
      validationErrors = ''

      publish(iteration, 'mapping')
      await runEngine({
        featuresDir: deps.featuresDir,
        logsDir: deps.logsDir,
        feature: m.feature,
        adapter: m.opts.agent,
        cwd: deps.projectRoot,
        onOutput: ctx.appendLog,
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
      ledger = compute(m.feature)
      passes.push({ pass: iteration, coveragePct: ledger.coveragePct, gapsOpen: gapRows(ledger).length })
      // Settle the pass in the published shape (phase stays 'mapping' — the
      // next loop head flips it to 'authoring' if another pass starts).
      publish(iteration, 'mapping')
    }

    if (targetMet(ledger, target)) return { kind: 'done', evidence: ledgerEvidence(ledger) }
    return {
      kind: 'checkpoint',
      checkpoint: {
        kind: 'coverage-stuck',
        message: `After ${MAX_ITERATIONS} authoring rounds coverage is ${ledger.coveragePct}% (target ${target}%). Accept the remaining gaps or run another round.`,
        options: ['accept-partial', 'retry'],
        data: ledgerEvidence(ledger),
      },
    }
  }

  return {
    run: loop,
    async onCheckpointResponse(ctx, response) {
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
