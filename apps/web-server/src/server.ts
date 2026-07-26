import path from 'path'
import fs from 'fs'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../shared/run-state'
import { runsRoutes, type ExternalHealAgentRequest } from './features/runs/routes/runs'
import { type TestsDraftRouteDeps } from './features/wizard/routes/tests-draft'
import { makeExternalHealAuditLogger } from './features/runs/routes/external-heal'
import { ExternalHealBroker } from './features/runs/logic/heal/external-heal-broker'
import { registerMcpRoutes } from './mcp/server'
import { register as registerAgentSessions } from './features/agent-sessions/index'
import { workspaceStreamRoutes } from './shared/ws/workspace-stream'
import { createRegistry, RunStore, type OrchestratorRegistry } from './features/runs/logic/run-store'
import { BenchmarkRunStore } from './features/benchmark/logic/runtime/store'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from './features/benchmark/logic/runtime/skills'
import { register as registerPortify } from './features/portify/index'
import { register as registerConfig } from './features/config/index'
import { register as registerCoverage } from './features/coverage/index'
import { register as registerFlights } from './features/flights/index'
import { register as registerRuns } from './features/runs/index'
import { register as registerWizard } from './features/wizard/index'
import { register as registerEvaluation } from './features/evaluation/index'
import { register as registerBenchmark } from './features/benchmark/index'
import { PortifyRunStore } from './features/portify/logic/runtime/store'
import { CoverageJobRunStore } from './features/coverage/logic/coverage/jobs/store'
import { FlightRunStore } from './features/flights/logic/store'
import { removeFlightRecordsForFeature } from './features/flights/logic/conductor'
import { PlanFeaturesStore } from './features/flights/logic/plan-features'
import { DirtySpecStore } from './features/runs/logic/dirty-specs/store'
import { startDirtySpecWatcher } from './features/runs/logic/dirty-specs/watcher'
import { reclaimOrphanedPortify } from './features/portify/logic/runtime/reclaim'
import {
  buildAgentSessionResponse,
  resolveWorkflowAgentRef,
} from './features/agent-sessions/logic/agent-session-log'
import { WorkspaceEventBus } from './shared/workspace-events'
import type { ServerContext } from './server-context'
import { UpdateJobStore } from './features/version/logic/update-job'
import { VersionState } from './features/version/logic/version-state'
import { register as registerVersion } from './features/version/index'
import { getInstalledPackageName, getInstalledPackageVersion } from '../../../shared/runtime/upgrade-check'
import { PaneBroker } from './features/runs/logic/pane-broker'
import { loadFeatures } from './shared/feature-loader'
import {
  spawnPlanAgent as makePlanAgentSpawner,
  spawnSpecAgent as makeSpecAgentSpawner,
} from './features/wizard/logic/wizard-agent-runner'
import { WizardAgentRegistry } from './features/wizard/logic/wizard-agent-registry'
import { reconcileInterruptedDrafts } from './features/wizard/logic/draft-store'
import { runDirFor, buildRunPaths } from './features/runs/logic/runtime/run-paths'
import { RunOrchestrator, collectPortSlots, buildServiceSpecs, buildQueuedServiceEntries } from './features/runs/logic/runtime/orchestrator'
import { RunScheduler, type SchedulerActiveRun } from './features/runs/logic/runtime/run-scheduler'
import { estimateRunCost, resolveAdmissionConfig, readSystemResources } from './features/runs/logic/runtime/admission'
import { detectRepoCollision, normalizeRepoPaths } from './features/runs/logic/runtime/repo-collision'
import { addWorktree, hydrateWorkingTreeDiff, linkNodeModules, type WorktreeHandle } from './features/runs/logic/runtime/repo-worktree'
import { overlayExists as portifyOverlayExists } from './features/portify/logic/runtime/overlay'
import { revertPortification } from './features/portify/logic/runtime/unportify'
import {
  buildAgentSpawnCommand,
  buildOrchestratorHealPrompt,
  pickAvailableHealAgent,
  resolveAgentBinary,
  type BuildHealCyclePrompt,
  type HealAgent,
} from './features/runs/logic/runtime/auto-heal'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from './shared/git-repo'
import { realPtyFactory, type PtyFactory } from './features/runs/logic/runtime/pty-spawner'
import {
  restore,
} from './features/runs/logic/runtime/env-switcher/switch'
import type { BackupRecord } from './features/runs/logic/runtime/env-switcher/types'
import {
  buildVerificationDiagnostics,
  resolveVerificationRun,
  type ResolveVerificationInput,
} from './features/coverage/logic/verification'



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
  // Host hook invoked after a port change is persisted via the Project
  // Settings dialog. The host (canary-lab ui) relaunches on the new port and
  // shuts this process down. Absent in tests / non-CLI embeddings.
  onPortChange?: (port: number) => void | Promise<void>
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
  const benchmarkStore = new BenchmarkRunStore(logsDir)
  // A benchmark left 'running'/'sabotaging' in the index belongs to a dead
  // process (this one just started) — flip it to 'aborted' so it doesn't resume
  // forever as running in the UI and so Stop isn't needed for it.
  benchmarkStore.reconcileInterrupted(() => new Date().toISOString())
  const portifyStore = new PortifyRunStore(logsDir)
  // A port-ification workflow left non-terminal belongs to a dead process.
  // Reclaim removes its orphaned worktrees + branches and restores the config
  // it edited in place, then flips the manifest to 'aborted' so the UI doesn't
  // show a zombie workflow (and a stale worktree can't wedge the next run).
  await reclaimOrphanedPortify(portifyStore, logsDir, () => new Date().toISOString())
  // Drop zombie history rows whose record dir was wiped out-of-band (logs
  // cleanup / manual rm) — they list but 404 on open + remove. (Distinct from
  // reclaim above, which handles live-but-dead workflows that still have a record.)
  portifyStore.pruneOrphans()
  // Coverage background jobs (R4): a job left 'running' belongs to a dead
  // process — flip it to 'aborted' so it doesn't hold the single-flight lock or
  // show as live forever.
  const coverageJobStore = new CoverageJobRunStore(logsDir)
  coverageJobStore.reconcileInterrupted(() => new Date().toISOString())
  // Flight background jobs: a flight left 'running' belongs to a dead
  // process — flip it to 'paused' (flights are resumable by design: the stage
  // array records where to pick up) so it neither holds the repo-keyed
  // single-flight lock nor shows as live forever.
  const flightStore = new FlightRunStore(logsDir)
  flightStore.reconcileInterrupted(() => new Date().toISOString())
  // Plan-features agent tasks: a task left 'running' belongs to a dead
  // process — flip it to 'failed' so the dialog offers "plan again" instead of
  // polling a corpse. (Queued flights the launch parked are drained by the
  // flights route registration below, once adapters exist to drive them.)
  const planStore = new PlanFeaturesStore(logsDir)
  planStore.reconcileInterrupted(() => new Date().toISOString())
  // Wizard drafts: a draft left 'planning'/'generating' by a server-spawned
  // agent belongs to a dead process — flip it to 'error' so the Flights pill
  // stops narrating a live "authoring" forever. External drafts are another
  // process's session and are deliberately left alone.
  reconcileInterruptedDrafts(logsDir, () => new Date().toISOString())
  const workspaceEvents = new WorkspaceEventBus()
  // Test-file integrity ("dirty") tracking. One feature-scoped store is the
  // single source of truth both the UI feature list and the MCP run result read.
  // Its change events drive the live red cue; the watcher recomputes on spec
  // edits + commits. Best-effort throughout — never blocks a run.
  const dirtySpecStore = new DirtySpecStore(logsDir)
  dirtySpecStore.onEvent((e) => {
    if (e.featureId) workspaceEvents.publish({ type: 'tests-dirty-changed', feature: e.featureId })
  })
  const dirtySpecWatcher = startDirtySpecWatcher({
    featuresDir,
    store: dirtySpecStore,
    log: (msg, err) => app.log.warn({ err }, msg),
    // A spec's content actually changed on disk — refetch source, not just the
    // dirty flag (tests-dirty-changed above only tells you *that* it changed).
    onSpecFileChanged: (feature) => workspaceEvents.publish({ type: 'tests-changed', feature }),
  })
  app.addHook('onClose', async () => {
    dirtySpecWatcher.close()
  })
  // Self-update job (npm install <pkg>@latest). A job left 'running' belongs to a
  // dead process — flip it to 'aborted' so it doesn't hold the single-flight lock
  // or show as installing forever.
  const updateStore = new UpdateJobStore(logsDir)
  updateStore.reconcileInterrupted(() => new Date().toISOString())
  // `runningVersion` is snapshotted once here — it's the version this process is
  // executing. A successful self-update rewrites package.json on disk, but the
  // running code stays old until restart, so we compare the registry `latest`
  // against this snapshot (not a fresh disk read) to keep the "restart to apply"
  // signal alive after an install.
  const versionState = new VersionState({
    packageName: getInstalledPackageName(),
    runningVersion: getInstalledPackageVersion(),
    workspaceEvents,
  })
  // Fire-and-forget registry check on boot, then re-check every 6h. Fail-silent;
  // never blocks startup. Unref so the interval can't keep the process alive.
  void versionState.refresh()
  const versionCheckTimer = setInterval(() => { void versionState.refresh() }, 6 * 60 * 60 * 1000)
  if (typeof versionCheckTimer.unref === 'function') versionCheckTimer.unref()
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
  const wizardAgents = new WizardAgentRegistry()
  // Tracks runs with an active envset so we can revert on run-complete or on
  // process termination. Cleared as runs finish.
  const activeEnvsets = new Map<string, BackupRecord[]>()
  // Real `claude -p` via node-pty in production; tests inject a fake. Shared by
  // every feature that spawns an agent, so it belongs to the boot core.
  const ptyFactory = opts.ptyFactory ?? realPtyFactory()

  // Everything above is process-lifetime state this composition root owns.
  // Below, features register themselves against it — a feature's `register`
  // reads what it needs from `ctx` instead of createServer knowing its shape.
  // Registration order is Fastify plugin order, so it is load-bearing.
  const ctx: ServerContext = {
    options: opts,
    projectRoot: opts.projectRoot,
    featuresDir,
    logsDir,
    journalPath,
    registry,
    runStore,
    benchmarkStore,
    portifyStore,
    coverageJobStore,
    flightStore,
    planStore,
    dirtySpecStore,
    updateStore,
    versionState,
    workspaceEvents,
    externalHealBroker,
    wizardAgents,
    brokers,
    activeEnvsets,
    ptyFactory,
  }

  // Feature registration. Order is Fastify plugin order; the static fallback
  // and the MCP mount below must stay last. Each feature reads what it needs
  // from `ctx` — adding or removing one should not touch anything else here.
  await registerConfig(app, ctx)
  await registerFlights(app, ctx)
  await registerVersion(app, ctx)
  // `runs` hands back the three primitives other features legitimately share:
  // the scheduler and stream attacher benchmark reuses, and the external-run
  // restart the MCP surface drives.
  const runs = await registerRuns(app, ctx)
  // coverage's verification orchestrator reuses the run stream attacher.
  await registerCoverage(app, ctx, runs)
  await registerWizard(app, ctx)
  await registerEvaluation(app, ctx)
  await registerBenchmark(app, ctx, runs)

  // Port-ification workflow: rewrite a feature's apps to use injectable ports,
  // proven by a concurrent double-boot, ending at a user commit. Same agent
  // selection policy as the benchmark (pin the chosen CLI; ignore global heal
  // setting).
  const { runner: portifyRunner } = await registerPortify(app, ctx)

  await app.register(workspaceStreamRoutes, { events: workspaceEvents })
  await registerAgentSessions(app, ctx)

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
    dirtySpecStore,
    // R76: deleting a suite deletes its flight history with it.
    removeFlightRecordsFor: (featureName) => removeFlightRecordsForFeature(flightStore, featureName),
    // Flight over MCP: reuse the flights REST routes so the MCP surface
    // shares the store + conductor (and single-flight guard) with the UI/CLI.
    flightsRequest: async (o) => {
      const resp = await app.inject({
        method: o.method,
        url: o.url,
        ...(o.payload !== undefined ? { payload: o.payload as Record<string, unknown> } : {}),
      })
      const body = (() => { try { return JSON.parse(resp.payload) } catch { return resp.payload } })() as unknown
      return { statusCode: resp.statusCode, body }
    },
	    startRun: async (feature, env, healAgent, isolation, executionType) => {
	      const resp = await app.inject({
	        method: 'POST',
	        url: '/api/runs',
	        payload: { feature, env, ...(healAgent ? { healAgent } : {}), ...(isolation ? { isolation } : {}), ...(executionType === 'boot' ? { mode: 'boot' } : {}) },
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
      const orch = await runs.restartExternalRun(runId, healAgent, guidance)
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
    // Port-ification workflow — reuse the in-process runner + store (the same
    // ones behind routes/portify.ts). save/cancel throw with a statusCode the
    // MCP tools surface as errors. The agent-spawning start/revise are GUI-only
    // (REST); the MCP surface is external-producer only.
    startExternalPortify: (input) => portifyRunner.startExternalPortify(input),
    submitExternalPortify: (workflowId) => portifyRunner.submitExternalPortify(workflowId),
    getPortify: (workflowId) => portifyStore.get(workflowId),
    savePortify: (workflowId) => portifyRunner.save(workflowId),
    cancelPortify: (workflowId) => portifyRunner.cancel(workflowId),
    // Un-portify a saved feature: revert the config (snapshot or legacy strip) +
    // delete the overlay, then emit so live clients update. Mirrors the REST route.
    removePortification: (feature) => {
      const f = loadFeatures(featuresDir).find((x) => x.name === feature)
      if (!f?.featureDir) throw Object.assign(new Error('feature not found'), { statusCode: 404 })
      const { reverted } = revertPortification(f.featureDir)
      workspaceEvents.publish({ type: 'features-changed' })
      return { name: f.name, portified: portifyOverlayExists(f.featureDir), reverted }
    },
	  })

  // Serve the built React frontend if it exists. In development the dist dir
  // is missing — fall back to a placeholder so `GET /` still returns something
  // meaningful instead of crashing the server boot.
  const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist')
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
  }

  return { app, registry, runStore, brokers, revertAllEnvsets, cancelAllWizardAgents }
}
