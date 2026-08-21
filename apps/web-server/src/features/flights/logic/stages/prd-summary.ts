import fs from 'fs'
import path from 'path'
import { applyExternalSummary, buildSummaryAuthoringContext, clearPrdSummary, regeneratePrdSummary } from '../../../coverage/logic/coverage/service'
import { parseSummarySubmission } from '../../../coverage/logic/coverage/external-submissions'
import { readPrdSummary } from '../../../coverage/logic/coverage/prd-summary'
import { writeWorkflowAgentRef } from '../../../agent-sessions/logic/agent-session-log'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { agentSpawnJob } from './stage-jobs'
import { extractJson, featureDirFor, type FlightStageDeps } from './context'
import { externalWorkCheckpoint, handsOffToClient, parkedOnExternalWork, rejectStaleSubmit } from './externalizable'
import { agentProgressSink } from './agent-progress'

// Distill features/<f>/docs/ into the requirement summary through the
// existing agentic PRD engine (stable requirement ids preserved by the engine
// itself). Harness predicate: _prd-summary.json exists with ≥1 live
// requirement — never the agent's word for it. Skipped when a fresh summary
// already covers the docs (resume / enhance path).
//
// Under an external stageProducer the same exercise is handed to the MCP
// client: the hand-off carries the SAME prompt the internal engine renders
// (buildSummaryAuthoringContext — the standalone start_external_summary
// context), and the submitted requirements go through the SAME canonical
// assembler (applyExternalSummary: id reconciliation, summary write). The
// verdict is still this stage's own disk predicate, whoever produced it.

function newestDocMtime(featureDir: string): number {
  const docsDir = path.join(featureDir, 'docs')
  let newest = 0
  try {
    for (const f of fs.readdirSync(docsDir)) {
      if (f.startsWith('_')) continue
      const mtime = fs.statSync(path.join(docsDir, f)).mtimeMs
      if (mtime > newest) newest = mtime
    }
  } catch {
    /* no docs dir */
  }
  return newest
}

export function prdSummaryStage(deps: FlightStageDeps): StageAdapter {
  const liveCount = (s: NonNullable<ReturnType<typeof readPrdSummary>>) =>
    s.requirements.filter((r) => !r.deprecated).length

  /** The stage's predicate, applied to WHICHEVER producer ran: a summary on
   *  disk with ≥1 live requirement. Shared by the internal spawn and the
   *  external consume deliberately — the failed arm guards the engine coming
   *  back empty, and the external path re-reads the same file so its evidence
   *  count is the disk's, not the submission's length. */
  const settleFromDisk = (ctx: StageContext): StageOutcome => {
    const m = ctx.manifest()
    const summary = readPrdSummary(featureDirFor(deps, m.feature))
    const count = summary ? liveCount(summary) : 0
    if (!summary || count === 0) {
      return { kind: 'failed', error: 'PRD summary produced no requirements — add richer docs and resume' }
    }
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    return { kind: 'done', evidence: { requirementCount: count } }
  }

  const runInternal = async (ctx: StageContext): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const stageDir = path.join(ctx.flightDir, 'prd-summary')
    const regenerate = deps.coverage?.regenerate ?? regeneratePrdSummary
    await regenerate({
      featuresDir: deps.featuresDir,
      feature: m.feature,
      adapter: m.opts.agent,
      cwd: deps.projectRoot,
      // Pause/abort must actually stop the distiller, not just stop waiting
      // for it — see the same hand-off in every other agent-spawning stage.
      signal: ctx.signal,
      // …and the scope is how a pause can WAIT for it to be gone rather than
      // merely having asked. Same dir the agent-session ref is parked in, so
      // one value identifies this stage's spawn everywhere.
      spawnScope: stageDir,
      agentJob: { record: { jobId: `${m.flightId}:prd-summary`, flightId: m.flightId, feature: m.feature, stage: 'prd-summary', agent: m.opts.agent ?? 'claude' }, logsDir: deps.logsDir },
      onOutput: agentProgressSink(ctx),
      onAgentSession: (session) => {
        writeWorkflowAgentRef(stageDir, {
          agent: session.agent,
          cwd: deps.projectRoot,
          spawnedAt: new Date().toISOString(),
          sessionId: session.sessionId,
        })
      },
    })
    return settleFromDisk(ctx)
  }

  /** Park the distillation on the client — or re-park it with the rejection
   *  reason. Rebuilt per park rather than copied off the old checkpoint: a
   *  flight can sit parked for a while and the docs (and the previous-id spine)
   *  may have moved under it. */
  const handOff = (ctx: StageContext, lastRejection?: string): StageOutcome => {
    const m = ctx.manifest()
    const built = buildSummaryAuthoringContext({ featuresDir: deps.featuresDir, feature: m.feature })
    if (built.kind === 'needs-docs') {
      // A client cannot conjure source docs any more than the local engine can,
      // so this is terminal for the attempt, not a hand-off: resume re-runs the
      // stage once docs exist again.
      return { kind: 'failed', error: 'no requirement docs to summarize — add docs and resume' }
    }
    ctx.appendLog(lastRejection
      ? `[prd-summary] external summary rejected — ${lastRejection}\n`
      : '[prd-summary] handed off to the external client\n')
    return externalWorkCheckpoint(ctx, 'prd-summary', built.context.prompt, {
      message: lastRejection
        ? `That summary was rejected: ${lastRejection}. Fix it and respond again with { requirements[] } on \`data\` — or answer "run-internally" to hand the step to Canary's own agent.`
        : 'Distill the requirement docs into testable requirements in your own client (the prompt lists the docs to read and the prior ids to preserve), then respond with { requirements[], variantDimension? } on `data`. Canary reconciles ids against the prior summary and writes the summary files itself.',
      context: {
        docs: built.context.docs,
        previousRequirementIds: built.context.previousRequirementIds,
        answerShape: { requirements: 'requirement[] — the shape the prompt specifies', variantDimension: '{ name, values }?' },
        ...(lastRejection === undefined ? {} : { lastRejection }),
      },
    })
  }

  return {
    // The PRD distiller. It spawns through the coverage engine rather than
    // defaultSpawnAgent, but it carries the same scope, so it is reached the
    // same way. (Parked on an external hand-off the stage owns no spawn and
    // the scope lookup no-ops.)
    teardown: (ctx) => agentSpawnJob(ctx, 'prd-summary'),
    async run(ctx) {
      const m = ctx.manifest()
      const featureDir = featureDirFor(deps, m.feature)

      const existing = readPrdSummary(featureDir)
      if (existing && liveCount(existing) > 0 && Date.parse(existing.generatedAt) >= newestDocMtime(featureDir)) {
        return { kind: 'done', evidence: { requirementCount: liveCount(existing), reused: true } }
      }

      if (handsOffToClient(ctx)) return handOff(ctx)
      return runInternal(ctx)
    },
    async onCheckpointResponse(ctx, response) {
      // The only checkpoint this stage parks is its own hand-off; a replayed
      // answer with nothing parked re-runs the stage (the StageAdapter default).
      if (!parkedOnExternalWork(ctx, 'prd-summary')) return this.run!(ctx)
      if (response.choice === 'run-internally') {
        ctx.appendLog('[prd-summary] client handed the step back — distilling here\n')
        return runInternal(ctx)
      }
      const stale = rejectStaleSubmit(ctx, 'prd-summary', response)
      if (stale) return stale
      // A rejected submission must RE-PARK, never settle `failed` — the
      // persisted checkpointResponse would replay the same failure on every
      // resume (scout's live-flight lesson).
      let data: unknown = response.data
      if (typeof data === 'string') {
        try {
          data = extractJson(data)
        } catch {
          return handOff(ctx, 'the submission was not parseable JSON')
        }
      }
      const parsed = parseSummarySubmission(data)
      if (!parsed.ok) return handOff(ctx, parsed.error)
      applyExternalSummary({
        featuresDir: deps.featuresDir,
        feature: ctx.manifest().feature,
        requirements: parsed.submission.requirements,
        ...(parsed.submission.variantDimension ? { variantDimension: parsed.submission.variantDimension } : {}),
      })
      // The apply wrote through the canonical assembler (id spine preserved);
      // the verdict is still the disk re-read, same as the internal spawn's.
      return settleFromDisk(ctx)
    },
    // R78 restart wipe: the existing coverage "redo from the start" clear —
    // drops _prd-summary.json/.md (and the downstream coverage state, which the
    // specs-coverage reset that always follows discards anyway). The docs
    // themselves belong to the docs stage; a restart HERE keeps them.
    async reset(ctx) {
      const m = ctx.manifest()
      if (!fs.existsSync(featureDirFor(deps, m.feature))) return
      clearPrdSummary({ featuresDir: deps.featuresDir, feature: m.feature })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    },
  }
}
