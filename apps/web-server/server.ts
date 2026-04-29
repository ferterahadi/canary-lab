import path from 'path'
import fs from 'fs'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import { featuresRoutes } from './routes/features'
import { runsRoutes } from './routes/runs'
import { journalRoutes } from './routes/journal'
import { skillsRoutes } from './routes/skills'
import { testsDraftRoutes, type TestsDraftRouteDeps } from './routes/tests-draft'
import { paneStreamRoutes } from './ws/pane-stream'
import { draftAgentStreamRoutes } from './ws/draft-agent-stream'
import { createRegistry, type OrchestratorRegistry, type OrchestratorLike } from './lib/run-store'
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
import { RunnerLog } from '../../shared/e2e-runner/runner-log'
import { realPtyFactory, type PtyFactory } from '../../shared/e2e-runner/pty-spawner'

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
  draftBrokers: Map<string, PaneBroker>
}

export async function createServer(opts: CreateServerOptions): Promise<CreateServerResult> {
  const featuresDir = opts.featuresDir ?? path.join(opts.projectRoot, 'features')
  const logsDir = opts.logsDir ?? path.join(opts.projectRoot, 'logs')
  const journalPath = opts.journalPath ?? path.join(logsDir, 'diagnosis-journal.md')

  const app = Fastify({ logger: false })
  await app.register(websocketPlugin)

  const registry = createRegistry()
  const brokers = new Map<string, PaneBroker>()
  const draftBrokers = new Map<string, PaneBroker>()

  await app.register(featuresRoutes, { featuresDir })
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
    startRun: async (featureName: string): Promise<OrchestratorLike> => {
      const features = loadFeatures(featuresDir)
      const feature = features.find((f) => f.name === featureName)
      if (!feature) throw new Error(`feature not found: ${featureName}`)
      const runId = generateRunId()
      const runDir = runDirFor(logsDir, runId)
      const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
      runnerLog.info(`Run started: feature=${feature.name} runId=${runId}`)
      const orch = new RunOrchestrator({
        feature,
        runId,
        runDir,
        ptyFactory: realPtyFactory(),
        runnerLog,
      })
      const broker = new PaneBroker()
      brokers.set(runId, broker)
      orch.on('service-output', ({ service, chunk }) => {
        broker.push(`service:${service.safeName}`, chunk)
      })
      orch.on('service-exit', ({ service, exitCode }) => {
        broker.markExit(`service:${service.safeName}`, exitCode)
      })
      orch.on('playwright-output', ({ chunk }) => {
        broker.push('playwright', chunk)
      })
      orch.on('playwright-exit', ({ exitCode }) => {
        broker.markExit('playwright', exitCode)
      })
      orch.on('agent-output', ({ chunk }) => {
        broker.push('agent', chunk)
      })
      // Fire-and-forget the full lifecycle — services + Playwright + heal
      // loop all drive through here. Failures surface via WebSocket events.
      orch.runFullCycle().catch((err) => {
        broker.push('agent', `\n[orchestrator error] ${String(err)}\n`)
      })
      return orch
    },
  })
  await app.register(paneStreamRoutes, {
    registry,
    brokerFor: (runId) => brokers.get(runId) ?? null,
  })
  await app.register(draftAgentStreamRoutes, {
    brokerForDraft: (draftId) => draftBrokers.get(draftId) ?? null,
  })

  return { app, registry, brokers, draftBrokers }
}
