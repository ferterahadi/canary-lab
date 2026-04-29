import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import { featuresRoutes } from './routes/features'
import { runsRoutes } from './routes/runs'
import { journalRoutes } from './routes/journal'
import { paneStreamRoutes } from './ws/pane-stream'
import { createRegistry, type OrchestratorRegistry, type OrchestratorLike } from './lib/run-store'
import { PaneBroker } from './lib/pane-broker'
import { loadFeatures } from './lib/feature-loader'
import { generateRunId } from '../../shared/e2e-runner/run-id'
import { runDirFor } from '../../shared/e2e-runner/run-paths'
import { RunOrchestrator } from '../../shared/e2e-runner/orchestrator'
import { realPtyFactory } from '../../shared/e2e-runner/pty-spawner'

// Bootstrap glue. Excluded from coverage — the testable logic lives under
// routes/ and lib/.

export interface CreateServerOptions {
  projectRoot: string
  featuresDir?: string
  logsDir?: string
  journalPath?: string
}

export interface CreateServerResult {
  app: FastifyInstance
  registry: OrchestratorRegistry
  brokers: Map<string, PaneBroker>
}

export async function createServer(opts: CreateServerOptions): Promise<CreateServerResult> {
  const featuresDir = opts.featuresDir ?? path.join(opts.projectRoot, 'features')
  const logsDir = opts.logsDir ?? path.join(opts.projectRoot, 'logs')
  const journalPath = opts.journalPath ?? path.join(logsDir, 'diagnosis-journal.md')

  const app = Fastify({ logger: false })
  await app.register(websocketPlugin)

  const registry = createRegistry()
  const brokers = new Map<string, PaneBroker>()

  await app.register(featuresRoutes, { featuresDir })
  await app.register(journalRoutes, { journalPath })
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
      const orch = new RunOrchestrator({
        feature,
        runId,
        runDir,
        ptyFactory: realPtyFactory(),
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

  return { app, registry, brokers }
}
