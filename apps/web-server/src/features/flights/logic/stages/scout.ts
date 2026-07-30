import path from 'path'
import { readFeatureConfig } from '../../../../shared/config-ast'
import { renderPrompt } from '../../../../shared/prompts'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { extractJson, stageFeedback, type FlightStageDeps, defaultSpawnAgent } from './context'
import { externalizable, externalWorkCheckpoint } from './externalizable'

// The one genuinely new agent prompt in the flight: read the target repo(s)
// and draft a feature.config.cjs (dev commands, port slots, health checks) +
// the env files the app needs. The agent proposes; the harness validates the
// draft parses (config AST) here and proves it boots later (env-capture's
// dry-run boot). Scout always completes — the config-approval checkpoint
// parks AFTER scaffold writes the real feature, so approval targets the
// on-disk feature.config.cjs (editable in place + via FeatureConfigEditor,
// two-way synced) instead of a draft string only the checkpoint holds.

export interface ScoutDraft {
  configSource: string
  envFiles: string[]
}

export function buildScoutPrompt(args: {
  repoPaths: string[]
  description: string
  feature: string
  env: string
  /** Re-entry note from Continue → from-a-step (R74). */
  feedback?: string
}): string {
  return renderPrompt('scout.md', {
    repoPaths: args.repoPaths.map((p) => `- ${p}`).join('\n'),
    description: args.description,
    featureJson: JSON.stringify(args.feature),
    descriptionJson: JSON.stringify(args.description),
    envJson: JSON.stringify(args.env),
    feedbackNote: args.feedback
      ? `Feedback on the previous attempt — take it into account: ${args.feedback}`
      : '',
  })
}

function validateDraft(draft: ScoutDraft): string | null {
  if (typeof draft.configSource !== 'string' || draft.configSource.trim() === '') {
    return 'agent returned no configSource'
  }
  try {
    readFeatureConfig(draft.configSource)
  } catch (err) {
    // readFeatureConfig only ever throws real Error/SyntaxError instances.
    return `draft feature.config.cjs does not parse: ${(err as Error).message}`
  }
  return null
}

/** Normalize + validate a draft from EITHER executor. The external client's answer
 *  is held to exactly the same bar as the local agent's — an unparseable
 *  feature.config.cjs fails the stage whoever produced it, so the stage's evidence
 *  stays evidence rather than becoming the producer's self-report. */
function settleDraft(draft: ScoutDraft): StageOutcome {
  draft.envFiles = Array.isArray(draft.envFiles) ? draft.envFiles.filter((f) => typeof f === 'string') : []
  const invalid = validateDraft(draft)
  if (invalid) return { kind: 'failed', error: invalid }
  return { kind: 'done', evidence: draft }
}

export function scoutStage(deps: FlightStageDeps): StageAdapter {
  const spawnAgent = deps.spawnAgent ?? defaultSpawnAgent

  const scoutPromptFor = (m: ReturnType<StageContext['manifest']>): string =>
    buildScoutPrompt({
      repoPaths: m.repoPaths,
      description: m.description,
      feature: m.feature,
      env: m.opts.env,
      feedback: stageFeedback(m, 'scout'),
    })

  const draftAndValidate = async (ctx: StageContext): Promise<StageOutcome> => {
    const m = ctx.manifest()
    ctx.appendLog(`[scout] reading ${m.repoPaths.join(', ')}…\n`)
    const { text } = await spawnAgent({
      prompt: scoutPromptFor(m),
      cwd: m.repoPaths[0],
      stageDir: path.join(ctx.flightDir, 'scout'),
      onChunk: ctx.appendLog,
      signal: ctx.signal,
      agent: m.opts.agent,
    })
    return settleDraft(extractJson<ScoutDraft>(text))
  }

  const internal: StageAdapter = {
    run: draftAndValidate,
    // LEGACY release path (remove after one release): manifests that parked on
    // scout's config-approval BEFORE the checkpoint moved to scaffold still
    // release correctly through the old responder.
    async onCheckpointResponse(ctx, response) {
      const stage = ctx.manifest().stages.find((s) => s.key === 'scout')
      const draft = stage?.checkpoint?.data as ScoutDraft | undefined
      const choice = response.choice ?? ''
      if (choice === 'approve' && draft) {
        const edited = (response.data as Partial<ScoutDraft> | undefined)?.configSource
        const final: ScoutDraft = edited ? { ...draft, configSource: edited } : draft
        const invalid = validateDraft(final)
        if (invalid) return { kind: 'failed', error: invalid }
        return { kind: 'done', evidence: final }
      }
      if (choice === 'redraft') return draftAndValidate(ctx)
      if (choice === 'reject') return { kind: 'failed', error: 'config draft rejected at the approval checkpoint' }
      if (!stage?.checkpoint) return draftAndValidate(ctx)
      return { kind: 'checkpoint', checkpoint: stage.checkpoint }
    },
  }

  return externalizable('scout', internal, {
    message: 'Survey the repos and draft the feature config in your own client, then respond with { configSource, envFiles } on `data`.',
    handOff: (ctx) => {
      const m = ctx.manifest()
      // The client executes the SAME prompt the local CLI would have, so both
      // executors work from one set of instructions — including the fan-out rule.
      return { prompt: scoutPromptFor(m), context: { repoPaths: m.repoPaths, answerShape: { configSource: 'string', envFiles: 'string[]' } } }
    },
    consume: async (ctx, result) => {
      // A rejected submission must RE-PARK, never settle `failed`. The stage's
      // checkpointResponse persists, so a resume REPLAYS the last answer — and a
      // failing one then fails identically forever, leaving the flight advanceable
      // only by a full redo. Re-parking replaces that answer with the next attempt.
      // (Found by driving a real flight; the unit test had asserted `failed` as
      // correct. docs' collector already re-parks for the same reason.)
      const reject = (why: string): StageOutcome => {
        ctx.appendLog(`[scout] external draft rejected — ${why}\n`)
        const m = ctx.manifest()
        return externalWorkCheckpoint(ctx, 'scout', scoutPromptFor(m), {
          message: `That draft was rejected: ${why}. Fix it and respond again with { configSource, envFiles } on \`data\` — or answer "run-internally" to hand the step to Canary's own agent.`,
          context: { repoPaths: m.repoPaths, answerShape: { configSource: 'string', envFiles: 'string[]' }, lastRejection: why },
        })
      }
      const draft = typeof result === 'string' ? extractJson<ScoutDraft>(result) : (result as ScoutDraft | undefined)
      if (!draft || typeof draft !== 'object') return reject('no draft was submitted')
      const settled = settleDraft({ ...draft })
      return settled.kind === 'failed' ? reject(settled.error) : settled
    },
  })
}
