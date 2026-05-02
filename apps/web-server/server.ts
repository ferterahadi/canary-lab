import path from 'path'
import fs from 'fs'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { featuresRoutes } from './routes/features'
import { featureConfigRoutes } from './routes/feature-config'
import { projectConfigRoutes } from './routes/project-config'
import { runsRoutes } from './routes/runs'
import { journalRoutes } from './routes/journal'
import { skillsRoutes } from './routes/skills'
import { testsDraftRoutes, type TestsDraftRouteDeps } from './routes/tests-draft'
import { paneStreamRoutes } from './ws/pane-stream'
import { draftAgentStreamRoutes } from './ws/draft-agent-stream'
import { createRegistry, reapStaleRuns, type OrchestratorRegistry, type OrchestratorLike } from './lib/run-store'
import { PaneBroker } from './lib/pane-broker'
import { loadFeatures } from './lib/feature-loader'
import { loadSkills, type SkillRecord } from './lib/skill-loader'
import {
  spawnPlanAgent as makePlanAgentSpawner,
  spawnSpecAgent as makeSpecAgentSpawner,
} from './lib/wizard-agent-runner'
import { generateRunId } from '../../shared/e2e-runner/run-id'
import { runDirFor, buildRunPaths } from '../../shared/e2e-runner/run-paths'
import { RunOrchestrator } from '../../shared/e2e-runner/orchestrator'
import {
  buildOrchestratorHealCommand,
  pickAvailableHealAgent,
  type HealAgent,
} from '../../shared/e2e-runner/auto-heal'
import { loadProjectConfig } from '../../shared/launcher/project-config'
import { RunnerLog } from '../../shared/e2e-runner/runner-log'
import { realPtyFactory, type PtyFactory } from '../../shared/e2e-runner/pty-spawner'
import {
  applySet,
  backup,
  getEnvSetsDir,
  loadConfig,
  resolveVars,
  restore,
} from '../../shared/env-switcher/switch'
import type { BackupRecord } from '../../shared/env-switcher/types'

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
  brokers: Map<string, PaneBroker>
  // Reverts every still-applied envset. Entry points should invoke on
  // SIGINT/SIGTERM so a crashed/killed run doesn't leave the user's `.env`
  // pointing at production.
  revertAllEnvsets: () => void
  draftBrokers: Map<string, PaneBroker>
}

export async function createServer(opts: CreateServerOptions): Promise<CreateServerResult> {
  const featuresDir = opts.featuresDir ?? path.join(opts.projectRoot, 'features')
  const logsDir = opts.logsDir ?? path.join(opts.projectRoot, 'logs')
  const journalPath = opts.journalPath ?? path.join(logsDir, 'diagnosis-journal.md')

  const app = Fastify({ logger: false })
  await app.register(websocketPlugin)

  const registry = createRegistry()
  // One-shot cleanup: any 'running'/'healing' entry in runs/index.json from a
  // previous server process whose heartbeat is older than the staleness window
  // gets flipped to 'aborted'. Runs without heartbeatAt (legacy) are left alone.
  await reapStaleRuns(logsDir, registry)
  const brokers = new Map<string, PaneBroker>()
  const draftBrokers = new Map<string, PaneBroker>()
  // Tracks runs with an active envset so we can revert on run-complete or on
  // process termination. Cleared as runs finish.
  const activeEnvsets = new Map<string, BackupRecord[]>()

  await app.register(featuresRoutes, { featuresDir })
  await app.register(featureConfigRoutes, { featuresDir })
  await app.register(projectConfigRoutes, { projectRoot: opts.projectRoot })
  await app.register(journalRoutes, { journalPath })
  await app.register(skillsRoutes, { listSkills: opts.listSkills })

  // Wizard route deps. Production: real claude -p via node-pty + on-demand
  // PaneBroker per draft so the WebSocket route can stream live agent output.
  const ptyFactory = opts.ptyFactory ?? realPtyFactory()
  const ensureDraftBroker = (draftId: string): PaneBroker => {
    let b = draftBrokers.get(draftId)
    if (!b) {
      b = new PaneBroker()
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
    newDraftId: () => generateRunId(),
    spawnPlanAgent: async (input) => {
      const broker = ensureDraftBroker(input.draftId)
      return makePlanAgentSpawner({ ptyFactory, broker })(input)
    },
    spawnSpecAgent: async (input) => {
      const broker = ensureDraftBroker(input.draftId)
      return makeSpecAgentSpawner({ ptyFactory, broker })(input)
    },
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

  await app.register(runsRoutes, {
    logsDir,
    featuresDir,
    registry,
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
      let autoHeal: { agent: HealAgent; buildCommand: (args: { cycle: number; outputDir: string }) => string } | undefined
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
            buildCommand: buildOrchestratorHealCommand({
              agent: agentChoice,
              projectRoot: opts.projectRoot,
              runDir,
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
        })
      } catch (err) {
        if (backups) restore(backups)
        throw err
      }

      if (backups) {
        activeEnvsets.set(runId, backups)
        orch.once('run-complete', () => {
          const records = activeEnvsets.get(runId)
          if (!records) return
          activeEnvsets.delete(runId)
          try {
            restore(records)
            runnerLog.info(`Reverted envset for ${feature.name}`)
          } catch (err) {
            runnerLog.warn(`envset revert failed: ${(err as Error).message}`)
          }
        })
      }
      const broker = new PaneBroker()
      brokers.set(runId, broker)
      orch.on('service-output', ({ service, chunk }) => {
        broker.push(`service:${service.safeName}`, chunk)
      })
      orch.on('service-exit', ({ service, exitCode }) => {
        broker.markExit(`service:${service.safeName}`, exitCode)
      })
      // Reset the playwright/agent panes whenever a NEW pty is about to be
      // spawned. The orchestrator emits `playwright-started` once per
      // Playwright invocation (initial run + each heal-cycle rerun) and
      // `agent-started` once per heal-cycle agent. Without resetting, a
      // subscriber that connects after the first exit replays the stale
      // `[pane exited]` and never sees the new stream.
      orch.on('playwright-started', () => {
        broker.resetPane('playwright')
      })
      orch.on('playwright-output', ({ chunk }) => {
        broker.push('playwright', chunk)
      })
      orch.on('playwright-exit', ({ exitCode }) => {
        broker.markExit('playwright', exitCode)
      })
      orch.on('agent-started', () => {
        broker.resetPane('agent')
      })
      orch.on('agent-output', ({ chunk }) => {
        broker.push('agent', chunk)
      })
      orch.on('agent-exit', ({ exitCode }) => {
        broker.markExit('agent', exitCode)
      })
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
  })
  await app.register(paneStreamRoutes, {
    registry,
    brokerFor: (runId) => brokers.get(runId) ?? null,
    logsDir,
  })
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

  return { app, registry, brokers, draftBrokers, revertAllEnvsets }
}
