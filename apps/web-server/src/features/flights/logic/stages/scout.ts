import path from 'path'
import { readFeatureConfig } from '../../../config/logic/config-ast'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { extractJson, type FlightStageDeps, defaultSpawnAgent } from './context'

// The one genuinely new agent prompt in the flight: read the target repo(s)
// and draft a feature.config.cjs (dev commands, port slots, health checks) +
// the env files the app needs. The agent proposes; the harness validates the
// draft parses (config AST) here and proves it boots later (env-capture's
// dry-run boot). Non-yolo flights park on config-approval before anything is
// written to the workspace.

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
  return [
    `You are onboarding product repo(s) into a Canary Lab E2E workspace. Inspect the repo(s) below — package.json scripts, lockfiles, Procfiles, docker-compose files, READMEs, .env* files — and draft the feature config that boots them for testing.`,
    ``,
    `Repos (one feature spans all of them):`,
    ...args.repoPaths.map((p) => `- ${p}`),
    `What to test: ${args.description}`,
    ``,
    `Reply with ONLY a JSON object in a \`\`\`json fence, shaped exactly:`,
    `{ "configSource": "<complete feature.config.cjs source>", "envFiles": ["<absolute path of each env file the app reads>"] }`,
    ``,
    `The configSource must be CommonJS shaped exactly \`const config = {...}\\nmodule.exports = { config }\` with:`,
    `- name: ${JSON.stringify(args.feature)}, description: ${JSON.stringify(args.description)}, envs: [${JSON.stringify(args.env)}], featureDir: __dirname`,
    `- repos: one entry per repo above: { name, localPath (the absolute path above), branch (current branch if obvious, else omit), startCommands: [...] }`,
    `- each startCommand: { command, name, ports: [{ name: '<slot>', env: 'PORT' }] when the service reads a port env var, healthCheck: { http: { url: 'http://localhost:\${port.<slot>}/<ready-path>' } } or { tcp: { port } } }`,
    `- ALWAYS declare a port slot and reference it via \${port.<slot>} in the healthCheck URL — never hardcode the port number in the URL — so concurrent runs don't clash. If the service reads its port from an env var other than PORT, set that var name in ports[].env.`,
    `- pick the dev/start command a developer would actually use (prefer package.json scripts); use the shortest command that boots the service ready for E2E.`,
    `Do not invent services that don't exist. Do not include commentary outside the JSON fence.`,
  ].join('\n')
}

function validateDraft(draft: ScoutDraft): string | null {
  if (typeof draft.configSource !== 'string' || draft.configSource.trim() === '') {
    return 'agent returned no configSource'
  }
  try {
    readFeatureConfig(draft.configSource)
  } catch (err) {
    return `draft feature.config.cjs does not parse: ${err instanceof Error ? err.message : String(err)}`
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
    })
    const draft = extractJson<ScoutDraft>(text)
    draft.envFiles = Array.isArray(draft.envFiles) ? draft.envFiles.filter((f) => typeof f === 'string') : []
    const invalid = validateDraft(draft)
    if (invalid) return { kind: 'failed', error: invalid }

    if (m.opts.yolo) return { kind: 'done', evidence: draft }
    return {
      kind: 'checkpoint',
      checkpoint: {
        kind: 'config-approval',
        message: `Scout drafted feature.config.cjs for "${m.feature}" (${draft.envFiles.length} env file(s) detected). Approve it to scaffold the feature — the config gets boot-verified after env capture.`,
        options: ['approve', 'redraft', 'reject'],
        data: draft,
      },
    }
  }

  return {
    run: draftAndValidate,
    async onCheckpointResponse(ctx, response) {
      const stage = ctx.manifest().stages.find((s) => s.key === 'scout')
      const draft = stage?.checkpoint?.data as ScoutDraft | undefined
      const choice = response.choice ?? ''
      if (choice === 'approve' && draft) {
        // The user may have hand-tweaked the draft in the approval UI.
        const edited = (response.data as Partial<ScoutDraft> | undefined)?.configSource
        const final: ScoutDraft = edited ? { ...draft, configSource: edited } : draft
        const invalid = validateDraft(final)
        if (invalid) return { kind: 'failed', error: invalid }
        return { kind: 'done', evidence: final }
      }
      if (choice === 'redraft') return draftAndValidate(ctx)
      if (choice === 'reject') return { kind: 'failed', error: 'config draft rejected at the approval checkpoint' }
      return { kind: 'checkpoint', checkpoint: stage!.checkpoint! }
    },
  }
}
