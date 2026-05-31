import path from 'path'
import fs from 'fs'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { isActiveRunStatus, isRestartableRunStatus } from '../../shared/run-state'
import { featuresRoutes } from './routes/features'
import { featureConfigRoutes } from './routes/feature-config'
import { verificationRoutes } from './routes/verification'
import { projectConfigRoutes } from './routes/project-config'
import { runsRoutes, type ExternalHealAgentRequest } from './routes/runs'
import { journalRoutes } from './routes/journal'
import { testsDraftRoutes, type TestsDraftRouteDeps } from './routes/tests-draft'
import { externalHealRoutes, makeExternalHealAuditLogger } from './routes/external-heal'
import { ExternalHealBroker } from './lib/external-heal-broker'
import { registerMcpRoutes } from './mcp/server'
import { paneStreamRoutes } from './ws/pane-stream'
import { runsStreamRoutes } from './ws/runs-stream'
import { draftAgentStreamRoutes } from './ws/draft-agent-stream'
import { agentSessionStreamRoutes } from './ws/agent-session-stream'
import { workspaceStreamRoutes } from './ws/workspace-stream'
import { createRegistry, RunStore, type OrchestratorRegistry, type OrchestratorLike, type StartRunOutcome } from './lib/run-store'
import { WorkspaceEventBus } from './lib/workspace-events'
import { PaneBroker } from './lib/pane-broker'
import { loadFeatures } from './lib/feature-loader'
import {
  spawnPlanAgent as makePlanAgentSpawner,
  spawnSpecAgent as makeSpecAgentSpawner,
} from './lib/wizard-agent-runner'
import { WizardAgentRegistry } from './lib/wizard-agent-registry'
import { generateRunId } from './lib/runtime/run-id'
import { runDirFor, buildRunPaths } from './lib/runtime/run-paths'
import { RunOrchestrator, collectPortSlots, buildServiceSpecs } from './lib/runtime/orchestrator'
import { allocatePorts } from './lib/runtime/port-allocator'
import { resolvePortTokens } from './lib/runtime/launcher/interpolate'
import { RunScheduler, type SchedulerActiveRun } from './lib/runtime/run-scheduler'
import { estimateRunCost, resolveAdmissionConfig, readSystemResources } from './lib/runtime/admission'
import { detectRepoCollision, normalizeRepoPaths } from './lib/runtime/repo-collision'
import { addWorktree, type WorktreeHandle } from './lib/runtime/repo-worktree'
import type { QueueReason } from '../../shared/run-state'
import type { FeatureConfig } from '../../shared/launcher/types'
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
import {
  buildVerificationDiagnostics,
  resolveVerificationRun,
  type ResolveVerificationInput,
} from './lib/verification'
import type { HealAgentChoice } from './lib/runtime/launcher/project-config'
import type { LocalHealAgent } from './lib/runtime/manifest'

// Allocate one free TCP port per declared port slot for this run so concurrent
// runs (even of the same app) never clash on a hardcoded port. Returns
// undefined when the feature declares no port slots — the run then behaves
// exactly as before. The orchestrator releases these ports on stop.
async function allocateRunPorts(
  feature: FeatureConfig,
  env: string | undefined,
): Promise<Map<string, number> | undefined> {
  const slots = collectPortSlots(feature, env)
  return slots.length > 0 ? await allocatePorts(slots) : undefined
}

// Apply a feature's envset in-process and return the backups to revert later.
// Returns null when the feature has no envsets configured (silent skip).
function applyFeatureEnvset(
  featureDir: string,
  setName: string,
  portMap?: Map<string, number>,
): BackupRecord[] | null {
  const envSetsDir = getEnvSetsDir(featureDir)
  if (!fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) return null
  const config = loadConfig(featureDir)
  const targets = config.feature.slots.map((slot) => ({
    slot,
    targetPath: resolveVars(config.slots[slot].target, config.appRoots),
  }))
  const backups = backup(targets, Date.now())
  // Resolve the reserved ${port.<slot>} namespace in each applied file so a
  // multi-service feature's inter-service config follows the run's allocated
  // ports. No port map (e.g. verify path) → verbatim copy.
  const resolve = portMap && portMap.size > 0
    ? (content: string) => resolvePortTokens(content, portMap)
    : undefined
  applySet(envSetsDir, setName, targets, resolve)
  return backups
}

function pickConfiguredHealAgent(
  configured: HealAgentChoice,
  persisted?: LocalHealAgent,
): HealAgent | null {
  if (persisted) return pickAvailableHealAgent(persisted)
  if (configured === 'auto') return pickAvailableHealAgent()
  if (configured === 'claude' || configured === 'codex') return pickAvailableHealAgent(configured)
  return null
}

// Bootstrap glue. Excluded from coverage — the testable logic lives under
// routes/ and lib/.

export interface CreateServerOptions {
  projectRoot: string
  featuresDir?: string
  logsDir?: string
  journalPath?: string
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
  const workspaceEvents = new WorkspaceEventBus()
  // One-shot cleanup: a fresh UI server starts with an empty registry, so any
  // persisted 'running'/'healing' row is from a previous server process and is
  // not controllable by this process. Finalize it immediately instead of
  // waiting for the heartbeat staleness window or requiring a manual Stop.
  await runStore.abortAllActiveOrStale()
  // Tracks which external AI client (Claude Desktop / Codex CLI etc.) holds
  // heal duty for each run. Routes hit this; the orchestrator subscribes to
  // claim-changed events through the run-store fan-out.
  const externalHealBroker = new ExternalHealBroker({
    now: () => Date.now(),
    emit: (event) => runStore.emit('event', event),
    patchManifest: (runId, patch) => runStore.patchManifest(runId, patch),
    audit: makeExternalHealAuditLogger(logsDir),
  })
  // Periodic sweep: any external session whose heartbeat is older than
  // HEARTBEAT_STALE_MS gets its status flipped to 'disconnected'. The
  // orchestrator's signal-wait loop is untouched — runs stay parked at
  // waiting-for-signal so the client can reconnect with the same session id
  // and resume without losing state.
  const externalHealWatchdog = setInterval(() => {
    try { externalHealBroker.markStaleClaims() } catch { /* best-effort */ }
  }, 5_000)
  // Don't keep the process alive solely for the watchdog interval — that
  // would prevent `canary-lab ui` from exiting cleanly on SIGINT/SIGTERM.
  if (typeof externalHealWatchdog.unref === 'function') externalHealWatchdog.unref()
  const brokers = new Map<string, PaneBroker>()
  const draftBrokers = new Map<string, PaneBroker>()
  const wizardAgents = new WizardAgentRegistry()
  // Tracks runs with an active envset so we can revert on run-complete or on
  // process termination. Cleared as runs finish.
  const activeEnvsets = new Map<string, BackupRecord[]>()

  await app.register(featuresRoutes, { featuresDir })
  await app.register(featureConfigRoutes, {
    featuresDir,
    workspaceEvents,
    isRepoActive: (featureName) => runStore
      .list({ feature: featureName })
      .some((run) => isActiveRunStatus(run.status)),
  })
  const startVerification = async (
    featureName: string,
    input: ResolveVerificationInput,
  ): Promise<OrchestratorLike> => {
    const features = loadFeatures(featuresDir)
    const feature = features.find((f) => f.name === featureName)
    if (!feature) throw Object.assign(new Error(`feature not found: ${featureName}`), { statusCode: 404 })

    const resolved = resolveVerificationRun(feature, input)
    const runId = generateRunId()
    const runDir = runDirFor(logsDir, runId)
    const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
    runnerLog.info(
      `Verify started: feature=${feature.name} envset=${resolved.metadata.playwrightEnvsetId} runId=${runId}`,
    )
    runnerLog.info('Verify is observational only: local services and heal loops are disabled.')

    let backups: BackupRecord[] | null = null
    try {
      backups = applyFeatureEnvset(feature.featureDir, resolved.metadata.playwrightEnvsetId)
      if (backups) runnerLog.info(`Applied Playwright envset "${resolved.metadata.playwrightEnvsetId}" for verification`)
    } catch (err) {
      runnerLog.warn(`envset apply failed: ${(err as Error).message}`)
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 500 })
    }

    const verificationFeature = { ...feature, repos: [] }
    let orch: RunOrchestrator
    try {
      orch = new RunOrchestrator({
        feature: verificationFeature,
        env: resolved.metadata.playwrightEnvsetId,
        runId,
        runDir,
        ptyFactory,
        runnerLog,
        runStateSink: runStore,
        executionType: 'verify',
        verification: resolved.metadata,
        playwrightEnv: resolved.playwrightEnv,
      })
    } catch (err) {
      if (backups) restore(backups)
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 500 })
    }

    attachRunStreams(orch, runnerLog, feature.name, backups)
    const broker = brokers.get(runId)!
    orch.runVerification()
      .then(async (status) => {
        await orch.stop(status).catch(() => {})
        if (status === 'failed') {
          const detail = runStore.get(runId)
          if (detail) {
            const diagnostics = buildVerificationDiagnostics(detail, runDir)
            runStore.patchManifest(runId, {
              verification: {
                ...resolved.metadata,
                diagnostics,
              },
            })
          }
        }
        registry.delete(orch.runId)
      })
      .catch(async (err) => {
        broker.push('playwright', `\n[verification error] ${String(err)}\n`)
        await orch.stop('aborted').catch(() => {})
        registry.delete(orch.runId)
      })
    return orch
  }
  await app.register(verificationRoutes, {
    featuresDir,
    store: runStore,
    startVerification,
  })
  await app.register(projectConfigRoutes, { projectRoot: opts.projectRoot })
  await app.register(journalRoutes, { logsDir, journalPath })
  // `restartLocalHeal` deferred until after the runs route declares its
  // production restartHeal closure — defined below and threaded back in via
  // a setter-style hook on the route deps.
  const externalHealDeps: Parameters<typeof externalHealRoutes>[1] = {
    store: runStore,
    broker: externalHealBroker,
  }
  await app.register(externalHealRoutes, externalHealDeps)

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

  const productionTestsDraftDeps: TestsDraftRouteDeps = {
    logsDir,
    projectRoot: opts.projectRoot,
    workspaceEvents,
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
    orch.on('service-started', ({ service }) => {
      broker.resetPane(`service:${service.safeName}`)
    })
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

  const restartExternalRun = async (
    runId: string,
    healAgentReq: { kind: 'external'; sessionId: string; clientKind: 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-desktop' | 'other'; clientVersion?: string; conversationName?: string },
    guidance?: string,
  ): Promise<OrchestratorLike> => {
    const detail = runStore.get(runId)
    if (!detail) throw Object.assign(new Error('run-not-found'), { statusCode: 404 })
    const manifest = detail.manifest
    if (!isRestartableRunStatus(manifest.status)) throw Object.assign(new Error('not-restartable'), { statusCode: 409 })

    const features = loadFeatures(featuresDir)
    const feature = features.find((f) => f.name === manifest.feature)
    if (!feature) throw Object.assign(new Error('feature not found'), { statusCode: 404 })

    const env = manifest.env ?? feature.envs?.[0]
    const runDir = runDirFor(logsDir, runId)
    const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)

    const portMap = await allocateRunPorts(feature, env)
    let backups: BackupRecord[] | null = null
    if (env) {
      try {
        backups = applyFeatureEnvset(feature.featureDir, env, portMap)
        if (backups) runnerLog.info(`Applied envset "${env}" for external restart ${feature.name}`)
      } catch (err) {
        runnerLog.warn(`envset apply failed: ${(err as Error).message}`)
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 500 })
      }
    }

    let repoBranchSnapshots
    try {
      await validateConfiguredRepoBranches(feature)
      repoBranchSnapshots = await collectRepoBranchSnapshots(feature)
    } catch (err) {
      if (backups) restore(backups)
      runnerLog.warn(`External restart rejected: ${(err as Error).message}`)
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 409 })
    }

    const nowIso = new Date().toISOString()
    const externalHealSession: import('./lib/runtime/manifest').ExternalHealSession = {
      sessionId: healAgentReq.sessionId,
      clientKind: healAgentReq.clientKind,
      ...(healAgentReq.clientVersion ? { clientVersion: healAgentReq.clientVersion } : {}),
      ...(healAgentReq.conversationName ? { conversationName: healAgentReq.conversationName } : {}),
      claimedAt: nowIso,
      lastHeartbeatAt: nowIso,
      status: 'connected',
      cycleCount: 0,
    }

    let orch: RunOrchestrator
    try {
      orch = new RunOrchestrator({
        feature,
        env,
        runId,
        runDir,
        portMap,
        ptyFactory,
        runnerLog,
        externalHeal: true,
        externalHealSession,
        repoBranchSnapshots,
        initialHealCycles: manifest.healCycles,
        runStateSink: runStore,
      })
    } catch (err) {
      if (backups) restore(backups)
      runnerLog.warn(`External restart failed: ${(err as Error).message}`)
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 500 })
    }

    externalHealBroker.claim(runId, {
      sessionId: healAgentReq.sessionId,
      clientKind: healAgentReq.clientKind,
      ...(healAgentReq.clientVersion ? { clientVersion: healAgentReq.clientVersion } : {}),
      ...(healAgentReq.conversationName ? { conversationName: healAgentReq.conversationName } : {}),
    })

    attachRunStreams(orch, runnerLog, feature.name, backups)
    const broker = brokers.get(runId)!
    broker.resetPane('agent')
    broker.push('agent', `\n[orchestrator] Restarting external heal${guidance ? `: ${guidance}` : ''}\n`)
    registry.set(runId, orch)
    orch.restartTerminalRun(guidance)
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
  }

  // ── Concurrency: admission + queue scheduler ──────────────────────────
  // Different apps run concurrently on distinct allocated ports; runs that
  // exceed the resource budget, or that decline worktree isolation against an
  // active run on the same repo, are parked here and promoted FIFO on run-end.
  const admissionConfig = resolveAdmissionConfig()
  const listActiveForScheduler = (): SchedulerActiveRun[] =>
    runStore.list()
      .filter((e) => isActiveRunStatus(e.status))
      .map((e) => {
        const detail = runStore.get(e.runId)
        return {
          runId: e.runId,
          feature: e.feature,
          repoPaths: detail?.manifest.repoPaths ?? [],
          cost: estimateRunCost(detail?.manifest.services?.length ?? 0),
        }
      })
  const scheduler = new RunScheduler({
    listActive: listActiveForScheduler,
    readResources: readSystemResources,
    config: admissionConfig,
  })
  runStore.onEvent((e) => { if (e.kind === 'finalized') void scheduler.promote() })

  // Map a set of resolved repo paths back to feature.config repo names so we
  // know which repos to isolate in a worktree.
  const repoNamesForPaths = (feature: FeatureConfig, paths: string[]): string[] => {
    const set = new Set(paths)
    return (feature.repos ?? [])
      .filter((r) => { const [p] = normalizeRepoPaths([r.localPath]); return p != null && set.has(p) })
      .map((r) => r.name)
  }

  // Persist a placeholder manifest for a queued run so it shows up in the UI
  // (status 'queued' + reason) before any process is spawned. Promotion later
  // overwrites this with the real running manifest under the same runId.
  const writeQueuedManifest = (
    runId: string,
    feature: FeatureConfig,
    env: string | undefined,
    reason: QueueReason,
  ): void => {
    const startedAt = new Date().toISOString()
    runStore.bootstrap({
      runId,
      executionType: 'run',
      feature: feature.name,
      featureDir: feature.featureDir,
      env,
      startedAt,
      status: 'queued',
      healCycles: 0,
      services: [],
      repoPaths: normalizeRepoPaths((feature.repos ?? []).map((r) => r.localPath)),
      queueReason: reason,
      heartbeatAt: startedAt,
    })
  }

  // Cancel a run that's still waiting in the queue (no orchestrator yet).
  const cancelQueuedRun = (runId: string): boolean => {
    if (!scheduler.cancel(runId)) return false
    runStore.finalize(runId, 'aborted', new Date().toISOString(), 0)
    return true
  }

  await app.register(runsRoutes, {
	    featuresDir,
	    projectRoot: opts.projectRoot,
	    store: runStore,
	    broker: externalHealBroker,
      workspaceEvents,
	    startRun: async (
      featureName: string,
      env?: string,
      healAgentReq?: { kind: 'external'; sessionId: string; clientKind: 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-desktop' | 'other'; clientVersion?: string; conversationName?: string },
      isolation?: 'worktree' | 'queue',
    ): Promise<StartRunOutcome> => {
      const features = loadFeatures(featuresDir)
      const feature = features.find((f) => f.name === featureName)
      if (!feature) throw new Error(`feature not found: ${featureName}`)
      await validateConfiguredRepoBranches(feature)
      const runId = generateRunId()
      const runDir = runDirFor(logsDir, runId)
      const sourceRepoPaths = normalizeRepoPaths((feature.repos ?? []).map((r) => r.localPath))
      const cost = estimateRunCost(buildServiceSpecs(feature, runDir, env).length)
      const collision = detectRepoCollision(sourceRepoPaths, listActiveForScheduler())
      if (collision && !isolation) {
        return {
          kind: 'collision',
          conflictingRunId: collision.conflictingRunId,
          conflictingFeature: collision.conflictingFeature,
          repoPaths: collision.repoPaths,
        }
      }
      const useWorktree = Boolean(collision) && isolation === 'worktree'
      const worktreeRepoNames = useWorktree && collision ? repoNamesForPaths(feature, collision.repoPaths) : []

      // The actual launch: envset apply, worktree isolation, orchestrator
      // construction + kickoff. Deferred and reused by the queue when the run
      // can't start immediately.
      const launch = async (): Promise<OrchestratorLike> => {
        const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
        runnerLog.info(
          `Run started: feature=${feature.name}${env ? ` env=${env}` : ''} runId=${runId}`,
        )
        const repoBranchSnapshots = await collectRepoBranchSnapshots(feature)

      const portMap = await allocateRunPorts(feature, env)
      let backups: BackupRecord[] | null = null
      if (env) {
        try {
          backups = applyFeatureEnvset(feature.featureDir, env, portMap)
          if (backups) runnerLog.info(`Applied envset "${env}" for ${feature.name}`)
        } catch (err) {
          runnerLog.warn(`envset apply failed: ${(err as Error).message}`)
          throw err
        }
      }

      // Wire the heal loop based on the project's heal-agent setting (or an
      // explicit per-request override):
      //   - body `healAgent.kind === 'external'` → skip auto-heal, set
      //     externalHeal mode, claim the broker for the supplied session.
      //   - project 'auto' (default) → prefer claude, fall back to codex.
      //   - project 'claude' / 'codex' → require that exact CLI on PATH.
      //   - project 'manual' → skip auto-heal entirely; the orchestrator's
      //     signal polling handles the user's hand-driven fix instead.
      //   - project 'external' → treated like manual at startup; the
      //     external client typically registers explicitly via the body
      //     override or `POST /heal-agent/claim` post-start.
      // If the chosen CLI isn't available, autoHeal stays undefined and the
      // run still works without the self-fixing cycle.
      const projectConfig = loadProjectConfig(opts.projectRoot)
      const isExternalRequest = healAgentReq?.kind === 'external'
      let externalHealSession: import('./lib/runtime/manifest').ExternalHealSession | undefined
      if (isExternalRequest && healAgentReq) {
        const nowIso = new Date().toISOString()
        externalHealSession = {
          sessionId: healAgentReq.sessionId,
          clientKind: healAgentReq.clientKind,
          ...(healAgentReq.clientVersion ? { clientVersion: healAgentReq.clientVersion } : {}),
          ...(healAgentReq.conversationName ? { conversationName: healAgentReq.conversationName } : {}),
          claimedAt: nowIso,
          lastHeartbeatAt: nowIso,
          status: 'connected',
          cycleCount: 0,
        }
      }
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
      const agentChoice = isExternalRequest
        ? null
        : pickConfiguredHealAgent(projectConfig.healAgent)
      if (isExternalRequest) {
        runnerLog.info(
          `Auto-heal disabled: external client (${healAgentReq?.clientKind}, session ${healAgentReq?.sessionId.slice(0, 8)}) will drive the heal loop.`,
        )
      } else if (projectConfig.healAgent === 'manual') {
        runnerLog.info('Auto-heal disabled: project config is set to "manual" — the run will pause for hand-driven fixes.')
      } else if (projectConfig.healAgent === 'external') {
        runnerLog.info('Auto-heal disabled: project config is set to "external" — the run will wait for an external client to claim heal.')
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

      const worktrees: WorktreeHandle[] = []
      for (const repoName of worktreeRepoNames) {
        const repo = (feature.repos ?? []).find((r) => r.name === repoName)
        if (!repo) continue
        try {
          worktrees.push(await addWorktree({ repoName, localPath: repo.localPath, worktreesDir: path.join(runDir, 'worktrees') }))
          runnerLog.info(`Isolated repo "${repoName}" in a per-run worktree.`)
        } catch (err) {
          runnerLog.warn(`Worktree isolation failed for "${repoName}"; running in place: ${(err as Error).message}`)
        }
      }
      let orch: RunOrchestrator
      try {
        orch = new RunOrchestrator({
          feature,
          env,
          runId,
          runDir,
          portMap,
          worktrees,
	          ptyFactory,
          runnerLog,
          autoHeal,
          manualHeal:
            !isExternalRequest && projectConfig.healAgent === 'manual',
          externalHeal: isExternalRequest || projectConfig.healAgent === 'external',
          externalHealSession,
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
      // If the request supplied an explicit external claim, register it with
      // the broker so heartbeats / signals from the matching session id are
      // recognised. The session was already baked into the initial manifest
      // by passing it to the orchestrator constructor; this call ensures the
      // in-memory map agrees and the audit log records the claim.
      if (isExternalRequest && healAgentReq) {
        externalHealBroker.claim(runId, {
          sessionId: healAgentReq.sessionId,
          clientKind: healAgentReq.clientKind,
          ...(healAgentReq.clientVersion ? { clientVersion: healAgentReq.clientVersion } : {}),
          ...(healAgentReq.conversationName ? { conversationName: healAgentReq.conversationName } : {}),
        })
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
        // Register synchronously so the scheduler's next fit() / promotion sees
        // this run as active before any await yields.
        registry.set(orch.runId, orch)
        return orch
      }

      // Collision declined worktree → queue until the conflicting repo frees.
      if (collision && isolation === 'queue') {
        writeQueuedManifest(runId, feature, env, 'repo-collision')
        scheduler.enqueue({ runId, feature: feature.name, repoPaths: sourceRepoPaths, cost, reason: 'repo-collision', launch: async () => { await launch() } })
        return { kind: 'queued', runId, reason: 'repo-collision' }
      }
      // Worktree-isolated runs can't collide, so they're gated on resources only.
      const schedRepoPaths = useWorktree ? [] : sourceRepoPaths
      const fit = scheduler.fits({ repoPaths: schedRepoPaths, cost })
      if (!fit.ok) {
        writeQueuedManifest(runId, feature, env, fit.reason)
        scheduler.enqueue({ runId, feature: feature.name, repoPaths: schedRepoPaths, cost, reason: fit.reason, launch: async () => { await launch() } })
        return { kind: 'queued', runId, reason: fit.reason }
      }
      const orch = await launch()
      return { kind: 'started', orch }
    },
    cancelQueuedRun,
    restartRun: async (runId: string) => {
      const detail = runStore.get(runId)
      if (!detail) return { ok: false, reason: 'run-not-found' as const }
      const manifest = detail.manifest
      if ((manifest.executionType ?? 'run') === 'verify') return { ok: false, reason: 'not-restartable' as const }
      if (isActiveRunStatus(manifest.status)) return { ok: false, reason: 'already-active' as const }
      if (!isRestartableRunStatus(manifest.status)) return { ok: false, reason: 'not-restartable' as const }

      const features = loadFeatures(featuresDir)
      const feature = features.find((f) => f.name === manifest.feature)
      if (!feature) return { ok: false, reason: 'not-restartable' as const }

      const runDir = runDirFor(logsDir, runId)
      const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
      const env = manifest.env ?? feature.envs?.[0]
      if (!manifest.env && env) {
        runnerLog.warn(`Restarting run for legacy manifest without persisted env; defaulting to "${env}".`)
      }
      const portMap = await allocateRunPorts(feature, env)
      let backups: BackupRecord[] | null = null
      if (env) {
        try {
          backups = applyFeatureEnvset(feature.featureDir, env, portMap)
          if (backups) runnerLog.info(`Applied envset "${env}" for run restart ${feature.name}`)
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
        runnerLog.warn(`Run restart rejected: ${(err as Error).message}`)
        return { ok: false, reason: 'not-restartable' as const }
      }

      const projectConfig = loadProjectConfig(opts.projectRoot)
      const preserveExternal = manifest.healMode === 'external'
      const preserveManual = manifest.healMode === 'manual'
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

      if (!preserveExternal && !preserveManual) {
        const agentChoice = pickConfiguredHealAgent(projectConfig.healAgent, manifest.healAgent)
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
            runnerLog.warn(`Auto-heal disabled for run restart: ${(err as Error).message}`)
          }
        } else {
          runnerLog.warn('Auto-heal disabled for run restart: no `claude` or `codex` CLI on PATH.')
        }
      }

      let orch: RunOrchestrator
      try {
        orch = new RunOrchestrator({
          feature,
          env,
          runId,
          runDir,
          portMap,
          ptyFactory,
          runnerLog,
          autoHeal,
          manualHeal: preserveManual,
          externalHeal: preserveExternal,
          externalHealSession: preserveExternal ? manifest.externalHealSession : undefined,
          repoBranchSnapshots,
          initialHealCycles: manifest.healCycles,
          runStateSink: runStore,
        })
      } catch (err) {
        if (backups) restore(backups)
        runnerLog.warn(`Run restart failed: ${(err as Error).message}`)
        return { ok: false, reason: 'spawn-failed' as const }
      }

      attachRunStreams(orch, runnerLog, feature.name, backups)
      const broker = brokers.get(runId)!
      broker.push('agent', '\n[orchestrator] Retesting remaining failed, skipped, and pending tests...\n')
      registry.set(runId, orch)
      orch.restartTerminalRun()
        .then(async (status) => {
          await orch.stop(status).catch(() => {})
          registry.delete(orch.runId)
        })
        .catch(async (err) => {
          broker.push('agent', `\n[orchestrator error] ${String(err)}\n`)
          await orch.stop('aborted').catch(() => {})
          registry.delete(orch.runId)
        })
      return { ok: true as const, mode: 'remaining' as const }
    },
    restartHeal: restartLocalHealClosure,
  })
  // Re-export the local-heal restart closure to the external-heal handoff
  // route now that it's defined. The route captures `deps.restartLocalHeal`
  // by reference at request time, so this late-bind is safe.
  externalHealDeps.restartLocalHeal = (runId, guidance) => restartLocalHealClosure(runId, guidance)
  // Inline definition below — extracted out of the runsRoutes deps object so
  // both runs (agent-input → restartHeal) and external-heal (handoff) paths
  // can share the same orchestrator-construction code without duplicating it.
  // The function body matches the previous inline definition exactly.
  async function restartLocalHealClosure(runId: string, text: string): Promise<{ ok: true } | { ok: false; reason: 'run-not-found' | 'not-restartable' | 'manual-mode' | 'spawn-failed' }> {
      const detail = runStore.get(runId)
      if (!detail) return { ok: false, reason: 'run-not-found' as const }
      const manifest = detail.manifest
      if ((manifest.executionType ?? 'run') === 'verify') return { ok: false, reason: 'not-restartable' as const }
      if (!isRestartableRunStatus(manifest.status)) return { ok: false, reason: 'not-restartable' as const }
      if (manifest.healMode === 'manual') return { ok: false, reason: 'manual-mode' as const }

      const features = loadFeatures(featuresDir)
      const feature = features.find((f) => f.name === manifest.feature)
      if (!feature) return { ok: false, reason: 'not-restartable' as const }

      const runDir = runDirFor(logsDir, runId)
      const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
      const projectConfig = loadProjectConfig(opts.projectRoot)
      if (!manifest.healAgent && projectConfig.healAgent === 'manual') {
        runnerLog.info('Heal restart rejected: project config is set to "manual".')
        return { ok: false, reason: 'manual-mode' as const }
      }
      const agentChoice = pickConfiguredHealAgent(projectConfig.healAgent, manifest.healAgent)
      if (!agentChoice) {
        runnerLog.warn('Heal restart failed: no `claude` or `codex` CLI on PATH.')
        return { ok: false, reason: 'spawn-failed' as const }
      }

      const env = manifest.env ?? feature.envs?.[0]
      if (!manifest.env && env) {
        runnerLog.warn(`Restarting heal for legacy run without persisted env; defaulting to "${env}".`)
      }
      const portMap = await allocateRunPorts(feature, env)
      let backups: BackupRecord[] | null = null
      if (env) {
        try {
          backups = applyFeatureEnvset(feature.featureDir, env, portMap)
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
          portMap,
	          ptyFactory,
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
  }
  await app.register(paneStreamRoutes, {
    registry,
    brokerFor: (runId) => brokers.get(runId) ?? null,
    logsDir,
  })
  await app.register(runsStreamRoutes, { store: runStore })
  await app.register(workspaceStreamRoutes, { events: workspaceEvents })
  await app.register(draftAgentStreamRoutes, {
    brokerForDraft: (draftId) => draftBrokers.get(draftId) ?? null,
  })
  await app.register(agentSessionStreamRoutes, {
    store: runStore,
    logsDir,
  })

  // MCP HTTP server — mounts at /mcp so Claude/Codex Desktop/CLI can connect
  // over the streamable HTTP transport. Tools wrap the REST endpoints
  // registered above; for `start_run` we reuse `app.inject()` rather than
  // duplicating the 270-line orchestrator-construction code.
  await app.register(registerMcpRoutes, {
    store: runStore,
    broker: externalHealBroker,
    featuresDir,
    projectRoot: opts.projectRoot,
    workspaceEvents,
	    startRun: async (feature, env, healAgent, isolation) => {
	      const resp = await app.inject({
	        method: 'POST',
	        url: '/api/runs',
	        payload: { feature, env, ...(healAgent ? { healAgent } : {}), ...(isolation ? { isolation } : {}) },
	      })
	      const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })() as Record<string, unknown>
	      if (resp.statusCode === 201 || resp.statusCode === 200) {
	        return { kind: 'started', runId: String(body.runId) }
	      }
	      if (resp.statusCode === 202) {
	        return { kind: 'queued', runId: String(body.runId), reason: body.queueReason === 'repo-collision' ? 'repo-collision' : 'resources' }
	      }
	      if (resp.statusCode === 409 && body.type === 'repo_collision_requires_choice') {
	        return {
	          kind: 'collision',
	          conflictingRunId: String(body.conflictingRunId),
	          conflictingFeature: String(body.conflictingFeature),
	          repoPaths: Array.isArray(body.repoPaths) ? body.repoPaths as string[] : [],
	          options: ['worktree', 'queue'],
	          message: String(body.message ?? 'Same-app collision.'),
	        }
	      }
	      const message = body && 'error' in body ? String(body.error) : String(resp.payload)
	      throw new Error(`start_run failed (${resp.statusCode}): ${message}`)
	    },
    restartExternalRun: async (runId, healAgent, guidance) => {
      const orch = await restartExternalRun(runId, healAgent, guidance)
      return { runId: orch.runId, mode: 'remaining' }
    },
    startVerification: async (feature, input) => {
      const resp = await app.inject({
        method: 'POST',
        url: `/api/features/${encodeURIComponent(feature)}/verifications`,
        payload: input,
      })
      if (resp.statusCode !== 200 && resp.statusCode !== 201) {
        const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })()
        const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : String(body)
        throw new Error(`execute_verification failed (${resp.statusCode}): ${message}`)
      }
      return JSON.parse(resp.payload) as { runId: string }
    },
    writeEnvsetSlot: async (feature, env, slot, entries) => {
      const resp = await app.inject({
        method: 'PUT',
        url: `/api/features/${encodeURIComponent(feature)}/envsets/${encodeURIComponent(env)}/${encodeURIComponent(slot)}`,
        payload: { entries },
      })
      const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })()
      if (resp.statusCode !== 200 && resp.statusCode !== 201) {
        const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : String(body)
        throw new Error(`write_envset failed (${resp.statusCode}): ${message}`)
      }
      return body as { path: string; entries: Array<{ key: string; value: string }>; unparsedLines: number[] }
    },
    handoffHeal: async (runId, to, sessionId, guidance) => {
      const resp = await app.inject({
        method: 'POST',
        url: `/api/runs/${encodeURIComponent(runId)}/heal-agent/handoff`,
        payload: {
          to,
          ...(sessionId ? { sessionId } : {}),
          ...(guidance ? { guidance } : {}),
        },
      })
      const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })()
      return { statusCode: resp.statusCode, body }
    },
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
