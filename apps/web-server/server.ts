import path from 'path'
import fs from 'fs'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { isActiveRunStatus, isRestartableRunStatus } from '../../shared/run-state'
import { featuresRoutes } from './routes/features'
import { featureConfigRoutes } from './routes/feature-config'
import { projectConfigRoutes } from './routes/project-config'
import { runsRoutes } from './routes/runs'
import { journalRoutes } from './routes/journal'
import { skillsRoutes } from './routes/skills'
import { testsDraftRoutes, type TestsDraftRouteDeps } from './routes/tests-draft'
import { paneStreamRoutes } from './ws/pane-stream'
import { runsStreamRoutes } from './ws/runs-stream'
import { draftAgentStreamRoutes } from './ws/draft-agent-stream'
import { createRegistry, RunStore, type OrchestratorRegistry, type OrchestratorLike } from './lib/run-store'
import { PaneBroker } from './lib/pane-broker'
import { loadFeatures } from './lib/feature-loader'
import { loadSkills, type SkillRecord } from './lib/skill-loader'
import {
  spawnPlanAgent as makePlanAgentSpawner,
  spawnSpecAgent as makeSpecAgentSpawner,
} from './lib/wizard-agent-runner'
import { WizardAgentRegistry } from './lib/wizard-agent-registry'
import { generateRunId } from './lib/runtime/run-id'
import { runDirFor, buildRunPaths } from './lib/runtime/run-paths'
import { RunOrchestrator } from './lib/runtime/orchestrator'
import {
  buildAgentSpawnCommand,
  buildOrchestratorHealPrompt,
  pickAvailableHealAgent,
  type BuildHealCyclePrompt,
  type HealAgent,
} from './lib/runtime/auto-heal'
import { loadProjectConfig } from './lib/runtime/launcher/project-config'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from './lib/git-repo'
import { RunnerLog } from './lib/runtime/runner-log'
import { realPtyFactory, type PtyFactory } from './lib/runtime/pty-spawner'
import {
  applySet,
  backup,
  getEnvSetsDir,
  loadConfig,
  resolveVars,
  restore,
} from './lib/runtime/env-switcher/switch'
import type { BackupRecord } from './lib/runtime/env-switcher/types'

// Apply a feature's envset in-process and return the backups to revert later.
// Returns null when the feature has no envsets configured (silent skip).
function applyFeatureEnvset(featureDir: string, setName: string): BackupRecord[] | null {
  const envSetsDir = getEnvSetsDir(featureDir)
  if (!fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) return null
  const config = loadConfig(featureDir)
  const targets = config.feature.slots.map((slot) => ({
    slot,
    targetPath: resolveVars(config.slots[slot].target, config.appRoots),
  }))
  const backups = backup(targets, Date.now())
  applySet(envSetsDir, setName, targets)
  return backups
}

// Bootstrap glue. Excluded from coverage — the testable logic lives under
// routes/ and lib/.

export interface CreateServerOptions {
  projectRoot: string
  featuresDir?: string
  logsDir?: string
  journalPath?: string
  // Test seams. Production wiring uses the defaults below.
  listSkills?: () => SkillRecord[]
  // Override the wizard agent spawners — tests inject sync stubs.
  testsDraftDepsOverride?: Partial<TestsDraftRouteDeps>
  // Override the pty factory used by the wizard runner. Production uses
  // the real node-pty factory; tests skip this branch by passing
  // `testsDraftDepsOverride` instead.
  ptyFactory?: PtyFactory
}

export interface CreateServerResult {
  app: FastifyInstance
  registry: OrchestratorRegistry
  /** Single mutator for run-state persistence. Phase 2 wires its `event`
   *  emitter to the runs WebSocket so the browser doesn't poll. */
  runStore: RunStore
  brokers: Map<string, PaneBroker>
  // Reverts every still-applied envset. Entry points should invoke on
  // SIGINT/SIGTERM so a crashed/killed run doesn't leave the user's `.env`
  // pointing at production.
  revertAllEnvsets: () => void
  draftBrokers: Map<string, PaneBroker>
  cancelAllWizardAgents: () => void
}

export async function createServer(opts: CreateServerOptions): Promise<CreateServerResult> {
  const featuresDir = opts.featuresDir ?? path.join(opts.projectRoot, 'features')
  const logsDir = opts.logsDir ?? path.join(opts.projectRoot, 'logs')
  const journalPath = opts.journalPath ?? path.join(logsDir, 'diagnosis-journal.md')

  const app = Fastify({ logger: false })
  await app.register(websocketPlugin)

  const registry = createRegistry()
  const runStore = new RunStore(logsDir, registry)
  // One-shot cleanup: a fresh UI server starts with an empty registry, so any
  // persisted 'running'/'healing' row is from a previous server process and is
  // not controllable by this process. Finalize it immediately instead of
  // waiting for the heartbeat staleness window or requiring a manual Stop.
  await runStore.abortAllActiveOrStale()
  const brokers = new Map<string, PaneBroker>()
  const draftBrokers = new Map<string, PaneBroker>()
  const wizardAgents = new WizardAgentRegistry()
  // Tracks runs with an active envset so we can revert on run-complete or on
  // process termination. Cleared as runs finish.
  const activeEnvsets = new Map<string, BackupRecord[]>()

  await app.register(featuresRoutes, { featuresDir })
  await app.register(featureConfigRoutes, {
    featuresDir,
    isRepoActive: (featureName) => runStore
      .list({ feature: featureName })
      .some((run) => isActiveRunStatus(run.status)),
  })
  await app.register(projectConfigRoutes, { projectRoot: opts.projectRoot })
  await app.register(journalRoutes, { logsDir, journalPath })
  await app.register(skillsRoutes, { listSkills: opts.listSkills })

  // Wizard route deps. Production: real claude -p via node-pty + on-demand
  // PaneBroker per draft so the WebSocket route can stream live agent output.
  const ptyFactory = opts.ptyFactory ?? realPtyFactory()
  const ensureDraftBroker = (draftId: string): PaneBroker => {
    let b = draftBrokers.get(draftId)
    if (!b) {
      b = new PaneBroker(Number.POSITIVE_INFINITY)
      draftBrokers.set(draftId, b)
    }
    return b
  }
  const skillProvider = opts.listSkills ?? (() => loadSkills())
  const skillById = (id: string): SkillRecord | undefined =>
    skillProvider().find((s) => s.id === id)

  const productionTestsDraftDeps: TestsDraftRouteDeps = {
    logsDir,
    projectRoot: opts.projectRoot,
    newDraftId: () => {
      const id = generateRunId()
      ensureDraftBroker(id)
      return id
    },
    pickAgent: () => {
      const projectConfig = loadProjectConfig(opts.projectRoot)
      if (projectConfig.healAgent === 'manual') {
        return {
          ok: false,
          error: 'Add Test generation requires Claude, Codex, or Auto. Project settings are currently set to Manual.',
        }
      }
      const agent = projectConfig.healAgent === 'auto'
        ? pickAvailableHealAgent()
        : pickAvailableHealAgent(projectConfig.healAgent)
      if (!agent) {
        return {
          ok: false,
          error: 'No configured wizard agent is available on PATH. Choose Auto, Claude, or Codex in settings and install the matching CLI.',
        }
      }
      return { ok: true, agent }
    },
    spawnPlanAgent: async (input) => {
      const broker = ensureDraftBroker(input.draftId)
      return makePlanAgentSpawner({ ptyFactory, broker, registry: wizardAgents })(input)
    },
    spawnSpecAgent: async (input) => {
      const broker = ensureDraftBroker(input.draftId)
      return makeSpecAgentSpawner({ ptyFactory, broker, registry: wizardAgents })(input)
    },
    cancelGeneration: (draftId: string) => wizardAgents.cancel(draftId),
    loadSkillContent: (id: string) => {
      const rec = skillById(id)
      if (!rec) return ''
      try {
        return fs.readFileSync(rec.path, 'utf8')
      } catch {
        return ''
      }
    },
  }

  const testsDraftDeps: TestsDraftRouteDeps = {
    ...productionTestsDraftDeps,
    ...(opts.testsDraftDepsOverride ?? {}),
  }
  await app.register(testsDraftRoutes, testsDraftDeps)

  const attachRunStreams = (
    orch: RunOrchestrator,
    runnerLog: RunnerLog,
    featureName: string,
    backups: BackupRecord[] | null,
  ): void => {
    const runId = orch.runId
    if (backups) {
      activeEnvsets.set(runId, backups)
      orch.once('run-complete', () => {
        const records = activeEnvsets.get(runId)
        if (!records) return
        activeEnvsets.delete(runId)
        try {
          restore(records)
          runnerLog.info(`Reverted envset for ${featureName}`)
        } catch (err) {
          runnerLog.warn(`envset revert failed: ${(err as Error).message}`)
        }
      })
    }
    const broker = brokers.get(runId) ?? new PaneBroker()
    brokers.set(runId, broker)
    orch.on('service-output', ({ service, chunk }) => {
      broker.push(`service:${service.safeName}`, chunk)
    })
    orch.on('service-exit', ({ service, exitCode }) => {
      broker.markExit(`service:${service.safeName}`, exitCode)
    })
    orch.on('playwright-started', () => {
      broker.resetPane('playwright')
    })
    orch.on('playwright-output', ({ chunk }) => {
      broker.push('playwright', chunk)
    })
    orch.on('playwright-exit', ({ exitCode }) => {
      broker.markExit('playwright', exitCode)
    })
    orch.on('agent-started', ({ redirect }) => {
      if (!redirect) broker.resetPane('agent')
    })
    orch.on('agent-output', ({ chunk }) => {
      broker.push('agent', chunk)
    })
    orch.on('agent-exit', ({ exitCode }) => {
      broker.markExit('agent', exitCode)
    })
  }

  await app.register(runsRoutes, {
    featuresDir,
    store: runStore,
    startRun: async (featureName: string, env?: string): Promise<OrchestratorLike> => {
      const features = loadFeatures(featuresDir)
      const feature = features.find((f) => f.name === featureName)
      if (!feature) throw new Error(`feature not found: ${featureName}`)
      const runId = generateRunId()
      const runDir = runDirFor(logsDir, runId)
      const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
      runnerLog.info(
        `Run started: feature=${feature.name}${env ? ` env=${env}` : ''} runId=${runId}`,
      )

      await validateConfiguredRepoBranches(feature)
      const repoBranchSnapshots = await collectRepoBranchSnapshots(feature)

      let backups: BackupRecord[] | null = null
      if (env) {
        try {
          backups = applyFeatureEnvset(feature.featureDir, env)
          if (backups) runnerLog.info(`Applied envset "${env}" for ${feature.name}`)
        } catch (err) {
          runnerLog.warn(`envset apply failed: ${(err as Error).message}`)
          throw err
        }
      }

      // Wire the heal loop based on the project's heal-agent setting:
      //   - 'auto' (default) → prefer claude, fall back to codex.
      //   - 'claude' / 'codex' → require that exact CLI on PATH.
      //   - 'manual' → skip auto-heal entirely; the orchestrator's signal
      //     polling handles the user's hand-driven fix instead.
      // If the chosen CLI isn't available, autoHeal stays undefined and the
      // run still works without the self-fixing cycle.
      const projectConfig = loadProjectConfig(opts.projectRoot)
      let autoHeal: {
        agent: HealAgent
        buildSpawnCommand: (args: {
          sessionId?: string
          resume?: boolean
          mcpOutputDir?: string
          promptFile?: string
        }) => string
        buildCyclePrompt: BuildHealCyclePrompt
      } | undefined
      const agentChoice = projectConfig.healAgent === 'manual'
        ? null
        : projectConfig.healAgent === 'auto'
          ? pickAvailableHealAgent()
          : pickAvailableHealAgent(projectConfig.healAgent)
      if (projectConfig.healAgent === 'manual') {
        runnerLog.info('Auto-heal disabled: project config is set to "manual" — the run will pause for hand-driven fixes.')
      }
      if (agentChoice) {
        try {
          autoHeal = {
            agent: agentChoice,
            buildSpawnCommand: ({ sessionId, resume, mcpOutputDir, promptFile }) => buildAgentSpawnCommand(agentChoice, {
              sessionId,
              resume,
              mcpOutputDir,
              mcpConfigFile: path.join(runDir, 'mcp-config.json'),
              promptFile,
            }),
            buildCyclePrompt: buildOrchestratorHealPrompt({
              agent: agentChoice,
              projectRoot: opts.projectRoot,
              runDir,
              personalWikiPath: projectConfig.personalWikiPath,
            }),
          }
        } catch (err) {
          runnerLog.warn(`Auto-heal disabled: ${(err as Error).message}`)
        }
      } else {
        runnerLog.warn('Auto-heal disabled: no `claude` or `codex` CLI on PATH (set CANARY_LAB_HEAL_AGENT=claude|codex to override).')
      }

      let orch: RunOrchestrator
      try {
        orch = new RunOrchestrator({
          feature,
          env,
          runId,
          runDir,
          ptyFactory: realPtyFactory(),
          runnerLog,
          autoHeal,
          manualHeal: projectConfig.healAgent === 'manual',
          repoBranchSnapshots,
          // Route every manifest/index write through RunStore so its event
          // emitter sees the mutation. Phase 2 attaches the WS endpoint to
          // these events.
          runStateSink: runStore,
        })
      } catch (err) {
        if (backups) restore(backups)
        throw err
      }

      attachRunStreams(orch, runnerLog, feature.name, backups)
      const broker = brokers.get(runId)!
      orch.runFullCycle()
        .then(async (status) => {
          await orch.stop(status).catch(() => {})
          registry.delete(orch.runId)
        })
        .catch(async (err) => {
          broker.push('agent', `\n[orchestrator error] ${String(err)}\n`)
          await orch.stop('aborted').catch(() => {})
          registry.delete(orch.runId)
      })
      return orch
    },
    restartHeal: async (runId: string, text: string) => {
      const detail = runStore.get(runId)
      if (!detail) return { ok: false, reason: 'run-not-found' as const }
      const manifest = detail.manifest
      if (!isRestartableRunStatus(manifest.status)) return { ok: false, reason: 'not-restartable' as const }
      if (manifest.healMode === 'manual') return { ok: false, reason: 'manual-mode' as const }

      const features = loadFeatures(featuresDir)
      const feature = features.find((f) => f.name === manifest.feature)
      if (!feature) return { ok: false, reason: 'not-restartable' as const }

      const runDir = runDirFor(logsDir, runId)
      const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
      const projectConfig = loadProjectConfig(opts.projectRoot)
      if (projectConfig.healAgent === 'manual') {
        runnerLog.info('Heal restart rejected: project config is set to "manual".')
        return { ok: false, reason: 'manual-mode' as const }
      }
      const agentChoice = projectConfig.healAgent === 'auto'
        ? pickAvailableHealAgent()
        : pickAvailableHealAgent(projectConfig.healAgent)
      if (!agentChoice) {
        runnerLog.warn('Heal restart failed: no `claude` or `codex` CLI on PATH.')
        return { ok: false, reason: 'spawn-failed' as const }
      }

      const env = manifest.env ?? feature.envs?.[0]
      if (!manifest.env && env) {
        runnerLog.warn(`Restarting heal for legacy run without persisted env; defaulting to "${env}".`)
      }
      let backups: BackupRecord[] | null = null
      if (env) {
        try {
          backups = applyFeatureEnvset(feature.featureDir, env)
          if (backups) runnerLog.info(`Applied envset "${env}" for restarted heal ${feature.name}`)
        } catch (err) {
          runnerLog.warn(`envset apply failed: ${(err as Error).message}`)
          return { ok: false, reason: 'spawn-failed' as const }
        }
      }

      let repoBranchSnapshots
      try {
        await validateConfiguredRepoBranches(feature)
        repoBranchSnapshots = await collectRepoBranchSnapshots(feature)
      } catch (err) {
        if (backups) restore(backups)
        runnerLog.warn(`Heal restart rejected: ${(err as Error).message}`)
        return { ok: false, reason: 'not-restartable' as const }
      }

      let orch: RunOrchestrator
      try {
        orch = new RunOrchestrator({
          feature,
          env,
          runId,
          runDir,
          ptyFactory: realPtyFactory(),
          runnerLog,
          autoHeal: {
            agent: agentChoice,
            buildSpawnCommand: ({ sessionId, resume, mcpOutputDir, promptFile }) => buildAgentSpawnCommand(agentChoice, {
              sessionId,
              resume,
              mcpOutputDir,
              mcpConfigFile: path.join(runDir, 'mcp-config.json'),
              promptFile,
            }),
            buildCyclePrompt: buildOrchestratorHealPrompt({
              agent: agentChoice,
              projectRoot: opts.projectRoot,
              runDir,
              personalWikiPath: projectConfig.personalWikiPath,
            }),
          },
          repoBranchSnapshots,
          initialHealCycles: manifest.healCycles,
          runStateSink: runStore,
        })
      } catch (err) {
        if (backups) restore(backups)
        runnerLog.warn(`Heal restart failed: ${(err as Error).message}`)
        return { ok: false, reason: 'spawn-failed' as const }
      }

      attachRunStreams(orch, runnerLog, feature.name, backups)
      const broker = brokers.get(runId)!
      // Clear the previous heal session's pane buffer (and signal live
      // subscribers via `reset`) so the new REPL streams into an empty
      // pane instead of below the dead-agent transcript. The transcript
      // file itself is also truncated below.
      broker.resetPane('agent')
      broker.push('agent', `\n[orchestrator] Restarting heal with ${agentChoice}...\n`)
      registry.set(runId, orch)
      orch.restartHealFromFailure(text)
        .then(async (status) => {
          await orch.stop(status).catch(() => {})
          registry.delete(orch.runId)
        })
        .catch(async (err) => {
          broker.push('agent', `\n[orchestrator error] ${String(err)}\n`)
          await orch.stop('aborted').catch(() => {})
          registry.delete(orch.runId)
        })
      return { ok: true as const }
    },
  })
  await app.register(paneStreamRoutes, {
    registry,
    brokerFor: (runId) => brokers.get(runId) ?? null,
    logsDir,
  })
  await app.register(runsStreamRoutes, { store: runStore })
  await app.register(draftAgentStreamRoutes, {
    brokerForDraft: (draftId) => draftBrokers.get(draftId) ?? null,
  })

  // Serve the built React frontend if it exists. In development the dist dir
  // is missing — fall back to a placeholder so `GET /` still returns something
  // meaningful instead of crashing the server boot.
  const webDist = path.resolve(__dirname, '..', 'web', 'dist')
  const indexHtmlPath = path.join(webDist, 'index.html')
  if (fs.existsSync(indexHtmlPath)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: false,
      decorateReply: false,
    })
    // SPA fallback for unknown non-API GETs — serve index.html so client-side
    // routes resolve. Restricted to GET; api/ws prefixes already match earlier
    // handlers because Fastify routes are matched in registration order and
    // these wildcards don't shadow specific routes.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
        reply.type('text/html').send(fs.readFileSync(indexHtmlPath))
        return
      }
      reply.code(404).send({ error: 'not found' })
    })
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html').send(
        '<!doctype html><title>Canary Lab</title><h1>Frontend not built yet</h1>'
        + '<p>Run <code>npm run build:web</code> to produce <code>apps/web/dist/</code>.</p>',
      )
    })
  }

  const revertAllEnvsets = (): void => {
    for (const [runId, records] of activeEnvsets) {
      try { restore(records) } catch { /* best-effort */ }
      activeEnvsets.delete(runId)
    }
  }

  const cancelAllWizardAgents = (): void => {
    wizardAgents.cancelAll()
    for (const broker of draftBrokers.values()) broker.destroy()
  }

  return { app, registry, runStore, brokers, draftBrokers, revertAllEnvsets, cancelAllWizardAgents }
}
