import fs from 'fs'
import path from 'path'
import { computeFeatureCoverage, runCoverageEngine } from '../../../coverage/logic/coverage/service'
import { readPrdSummary } from '../../../coverage/logic/coverage/prd-summary'
import { applyExternalDraftFiles } from '../../../config/logic/feature-authoring'
import { writeWorkflowAgentRef } from '../../../agent-sessions/logic/agent-session-log'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { CoverageLedger } from '../../../../../../../shared/coverage/types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { defaultSpawnAgent, extractJson, featureDirFor, type FlightStageDeps } from './context'

// The specs↔coverage loop: author Playwright specs (agent proposes, the
// existing draft-apply validation gates the write), map them with the
// existing coverage engine, recompute the ledger, and repeat until the
// harness-computed coverage meets the target (default 100% — no untested /
// path-incomplete / variant-incomplete). Bounded: when the loop can't close
// the remaining gaps it parks on coverage-stuck instead of spinning.

const MAX_ITERATIONS = 5
const MAX_EXISTING_SPEC_BYTES = 120 * 1024

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

function existingSpecs(featureDir: string): Array<{ path: string; content: string }> {
  const e2eDir = path.join(featureDir, 'e2e')
  const specs: Array<{ path: string; content: string }> = []
  let budget = MAX_EXISTING_SPEC_BYTES
  try {
    for (const f of fs.readdirSync(e2eDir)) {
      if (!f.endsWith('.spec.ts')) continue
      const content = fs.readFileSync(path.join(e2eDir, f), 'utf-8')
      if (content.length > budget) continue
      budget -= content.length
      specs.push({ path: `e2e/${f}`, content })
    }
  } catch {
    /* no e2e dir yet */
  }
  return specs
}

export function buildSpecsPrompt(args: {
  feature: string
  description: string
  /** Absolute path of the feature's config — the agent reads it for port slots. */
  configPath: string
  requirements: unknown
  gaps: GapRow[]
  specs: Array<{ path: string; content: string }>
  iteration: number
}): string {
  return [
    `You are authoring Playwright E2E specs for the Canary Lab feature "${args.feature}" (${args.description}).`,
    `Close every coverage gap below by writing/rewriting spec files.`,
    `Read the feature config at ${args.configPath} first — it declares the services, port slots, and health-check URLs the booted app exposes; target those.`,
    ``,
    `Requirements (from the PRD summary):`,
    '```json',
    JSON.stringify(args.requirements, null, 1),
    '```',
    ``,
    `Open gaps to close${args.iteration > 1 ? ` (iteration ${args.iteration} — previous specs did not close these)` : ''}:`,
    '```json',
    JSON.stringify(args.gaps, null, 1),
    '```',
    args.specs.length > 0 ? `Existing spec files (rewrite freely — a returned file replaces the one at its path):` : `No spec files exist yet.`,
    ...args.specs.flatMap((s) => [`--- ${s.path}`, '```ts', s.content, '```']),
    ``,
    `Hard rules:`,
    `- Files live directly under e2e/ and end in .spec.ts.`,
    `- Every spec imports: import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'`,
    `- Tag each test title with the requirement + path it covers: "@req-<id> @path-<happy|sad|edge>" (and "@variant-<value>" when the requirement spans variants). One test may carry several tags.`,
    `- Tests hit the app through the URLs/ports the feature config boots — use process.env like the existing specs do; never hardcode a port.`,
    `- Assert real user-observable effects, not merely 200s.`,
    ``,
    `Reply with ONLY a JSON object in a \`\`\`json fence: { "files": [{ "path": "e2e/<name>.spec.ts", "content": "<full file>" }] }`,
  ].join('\n')
}

export function specsCoverageStage(deps: FlightStageDeps): StageAdapter {
  const spawnAgent = deps.spawnAgent ?? defaultSpawnAgent

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
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      if (targetMet(ledger, target)) {
        return { kind: 'done', evidence: ledgerEvidence(ledger) }
      }
      ctx.appendLog(`[specs] iteration ${iteration}: ${ledger.coveragePct}% / ${target}% — ${gapRows(ledger).length} gap(s)\n`)

      const { text } = await spawnAgent({
        prompt: buildSpecsPrompt({
          feature: m.feature,
          description: m.description,
          configPath: path.join(featureDir, 'feature.config.cjs'),
          requirements,
          gaps: gapRows(ledger),
          specs: existingSpecs(featureDir),
          iteration,
        }),
        cwd: deps.projectRoot,
        // One stable sidecar dir per stage — each iteration re-pins the ref so
        // the flight view's AgentSessionView follows the newest spawn.
        stageDir: path.join(ctx.flightDir, 'specs-coverage'),
        onChunk: ctx.appendLog,
      })
      const proposal = extractJson<{ files?: Array<{ path: string; content: string }> }>(text)
      const files = Array.isArray(proposal.files) ? proposal.files : []
      const applied = applyExternalDraftFiles({ featureDir, files })
      if (!applied.ok) {
        ctx.appendLog(`[specs] proposal rejected: ${applied.error}\n`)
        continue // burns an iteration; the bound keeps this finite
      }
      ctx.appendLog(`[specs] wrote ${applied.written.length} file(s)\n`)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: m.feature })

      await runEngine({
        featuresDir: deps.featuresDir,
        logsDir: deps.logsDir,
        feature: m.feature,
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
  }
}
