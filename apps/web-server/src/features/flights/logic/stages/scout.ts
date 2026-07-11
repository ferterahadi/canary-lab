import path from 'path'
import { readFeatureConfig } from '../../../config/logic/config-ast'
import { renderPrompt } from '../../../../shared/prompts'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { extractJson, type FlightStageDeps, defaultSpawnAgent } from './context'

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
}): string {
  return renderPrompt('scout.md', {
    repoPaths: args.repoPaths.map((p) => `- ${p}`).join('\n'),
    description: args.description,
    featureJson: JSON.stringify(args.feature),
    descriptionJson: JSON.stringify(args.description),
    envJson: JSON.stringify(args.env),
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

export function scoutStage(deps: FlightStageDeps): StageAdapter {
  const spawnAgent = deps.spawnAgent ?? defaultSpawnAgent

  const draftAndValidate = async (ctx: StageContext): Promise<StageOutcome> => {
    const m = ctx.manifest()
    ctx.appendLog(`[scout] reading ${m.repoPaths.join(', ')}…\n`)
    const { text } = await spawnAgent({
      prompt: buildScoutPrompt({
        repoPaths: m.repoPaths,
        description: m.description,
        feature: m.feature,
        env: m.opts.env,
      }),
      cwd: m.repoPaths[0],
      stageDir: path.join(ctx.flightDir, 'scout'),
      onChunk: ctx.appendLog,
      signal: ctx.signal,
    })
    const draft = extractJson<ScoutDraft>(text)
    draft.envFiles = Array.isArray(draft.envFiles) ? draft.envFiles.filter((f) => typeof f === 'string') : []
    const invalid = validateDraft(draft)
    if (invalid) return { kind: 'failed', error: invalid }
    return { kind: 'done', evidence: draft }
  }

  return {
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
}
