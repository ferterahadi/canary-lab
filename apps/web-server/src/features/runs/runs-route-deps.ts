// The dependency object the runs REST surface is registered with: every callback
// the routes hand back into the run loop. Split out of index.ts, where it was a
// 430-line object literal inline in `register` — the closures it is built from
// now arrive as an explicit `parts` argument instead of being captured.
import path from 'path'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import type { ClientKind } from '../../../../../shared/run-mode'
import { runsRoutes } from './routes/runs'
import { pickConfiguredHealAgent } from './pick-heal-agent'
import { type OrchestratorLike, type StartRunOutcome } from './logic/run-store'
import { allocateRunPorts, applyFeatureEnvset } from './logic/runtime/run-primitives'
import type { ServerContext } from '../../server-context'
import { loadFeatures } from '../../shared/feature-loader'
import { generateRunId } from './logic/runtime/run-id'
import { runDirFor, buildRunPaths } from './logic/runtime/run-paths'
import { RunOrchestrator, buildServiceSpecs } from './logic/runtime/orchestrator'
import { estimateRunCost } from './logic/runtime/admission'
import { detectRepoCollision, normalizeRepoPaths } from './logic/runtime/repo-collision'
import { addWorktree, hydrateWorkingTreeDiff, linkNodeModules, type WorktreeHandle } from './logic/runtime/repo-worktree'
import { overlayExists as portifyOverlayExists } from '../portify/logic/runtime/overlay'
import { buildAgentSpawnCommand, buildOrchestratorHealPrompt, resolveAgentBinary, type BuildHealCyclePrompt, type HealAgent } from './logic/runtime/auto-heal'
import { loadProjectConfig } from './logic/runtime/launcher/project-config'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from '../../shared/git-repo'
import { RunnerLog } from './logic/runtime/runner-log'
import {
  restore,
} from './logic/runtime/env-switcher/switch'
import type { BackupRecord } from './logic/runtime/env-switcher/types'
import type { ExecutionType } from '../../../../../shared/verification'
import type { makeAttachRunStreams, makeRestartExternalRun } from './run-stream-wiring'
import type { buildRunScheduling } from './run-scheduling'

export interface RunsRouteDepsParts {
  attachRunStreams: ReturnType<typeof makeAttachRunStreams>
  restartExternalRun: ReturnType<typeof makeRestartExternalRun>
  scheduling: ReturnType<typeof buildRunScheduling>
  restartLocalHeal: (runId: string, text: string) => Promise<{ ok: true } | { ok: false; reason: 'run-not-found' | 'not-restartable' | 'manual-mode' | 'spawn-failed' }>
}

export function buildRunsRouteDeps(
  ctx: ServerContext,
  parts: RunsRouteDepsParts,
): Parameters<typeof runsRoutes>[1] {
  const {
    projectRoot,
    featuresDir,
    logsDir,
    registry,
    runStore,
    benchmarkStore,
    dirtySpecStore,
    workspaceEvents,
    externalHealBroker,
    brokers,
    activeEnvsets,
    ptyFactory,
  } = ctx
  const { attachRunStreams, restartExternalRun, restartLocalHeal } = parts
  const { admissionConfig, listActiveForScheduler, scheduler, writeQueuedManifest, cancelQueuedRun } =
    parts.scheduling
  return {
	    featuresDir,
	    projectRoot: projectRoot,
	    store: runStore,
	    broker: externalHealBroker,
      workspaceEvents,
      isWorktreeOwnerActive: (kind, id) => {
        if (kind === 'run') {
          const d = runStore.get(id)
          return d ? isActiveRunStatus(d.manifest.status) : false
        }
        const m = benchmarkStore.get(id)
        return m ? (m.status === 'running' || m.status === 'sabotaging' || m.status === 'ready') : false
      },
	    startRun: async (
      featureName: string,
      env?: string,
      healAgentReq?: { kind: 'external'; sessionId: string; clientKind: ClientKind; clientVersion?: string; conversationName?: string; claimable?: boolean },
      isolation?: 'worktree' | 'queue',
      executionType: ExecutionType = 'run',
    ): Promise<StartRunOutcome> => {
      const isBoot = executionType === 'boot'
      const features = loadFeatures(featuresDir)
      const feature = features.find((f) => f.name === featureName)
      if (!feature) throw new Error(`feature not found: ${featureName}`)
      await validateConfiguredRepoBranches(feature)
      const runId = generateRunId()
      const runDir = runDirFor(logsDir, runId)
      const sourceRepoPaths = normalizeRepoPaths((feature.repos ?? []).map((r) => r.localPath))
      const cost = estimateRunCost(buildServiceSpecs(feature, runDir, env).length)
      // A portified feature ALWAYS runs worktree-isolated: its saved overlay is
      // applied into per-run worktrees so two boots get disjoint injected ports.
      // That makes it inherently collision-free, so we auto-isolate (no user
      // prompt) and isolate EVERY repo, not just the colliding ones.
      const portified = portifyOverlayExists(feature.featureDir)
      const collision = detectRepoCollision(sourceRepoPaths, listActiveForScheduler())
      if (collision && !isolation && !portified) {
        return {
          kind: 'collision',
          conflictingRunId: collision.conflictingRunId,
          conflictingFeature: collision.conflictingFeature,
          repoPaths: collision.repoPaths,
        }
      }
      // R80: EVERY regular test run is worktree-isolated (all repos), so its
      // heal edits are CAPTURED as a diff and the product repos are never
      // mutated. Portified runs still get their overlay + disjoint injected
      // ports; the collision prompt still gates concurrent NON-portified runs
      // (worktrees isolate the working tree, not the feature's FIXED ports). A
      // repo that can't worktree falls back in place (loop below). Boot/verify/
      // benchmark sessions keep the prior portified/collision-only behavior —
      // they don't heal, so there's nothing to capture.
      const alwaysWorktree = executionType === 'run'
      const useWorktree = portified || alwaysWorktree || (Boolean(collision) && isolation === 'worktree')
      const worktreeRepoNames = useWorktree ? (feature.repos ?? []).map((r) => r.name) : []

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

      // Wire the heal loop. The run's *trigger source* decides the mode, not
      // just the project setting:
      //   - external origin (any MCP-triggered run, `healAgent.kind ===
      //     'external'`) → skip project auto-heal, set externalHeal mode. The
      //     project Heal Agent setting applies ONLY to UI/REST-triggered runs.
      //   - of those, only a *claimable* request (Desktop, `claimable !==
      //     false`) gets an externalHealSession + broker claim. A non-claimable
      //     external origin (CLI / 'other') still runs in external mode and
      //     waits for a Desktop/UI drive — Canary Lab does not spawn its own
      //     auto-heal agent for it.
      //   - UI/REST run with no external request → project config decides:
      //     'auto' prefers claude→codex; 'claude'/'codex' require that CLI;
      //     'manual' skips auto-heal (signal polling drives); 'external' waits
      //     for a client to claim.
      // If the chosen CLI isn't available, autoHeal stays undefined and the
      // run still works without the self-fixing cycle.
      const projectConfig = loadProjectConfig(projectRoot)
      const externalOrigin = healAgentReq?.kind === 'external'
      const canClaim = externalOrigin && healAgentReq?.claimable !== false
      let externalHealSession: import('./logic/runtime/manifest').ExternalHealSession | undefined
      if (canClaim && healAgentReq) {
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
      const agentChoice = (externalOrigin || isBoot)
        ? null
        : pickConfiguredHealAgent(projectConfig.healAgent)
      if (isBoot) {
        runnerLog.info('Boot-only session: booting services and holding them — no tests, no heal.')
      } else if (externalOrigin && canClaim) {
        runnerLog.info(
          `Auto-heal disabled: external client (${healAgentReq?.clientKind}, session ${healAgentReq?.sessionId.slice(0, 8)}) claimed and will drive the heal loop.`,
        )
      } else if (externalOrigin) {
        runnerLog.info(
          `Auto-heal disabled: run triggered by an external client (${healAgentReq?.clientKind}) that can't claim heal — waiting in external mode for a Desktop/UI drive.`,
        )
      } else if (projectConfig.healAgent === 'manual') {
        runnerLog.info('Auto-heal disabled: project config is set to "manual" — the run will pause for hand-driven fixes.')
      } else if (projectConfig.healAgent === 'external') {
        runnerLog.info('Auto-heal disabled: project config is set to "external" — the run will wait for an external client to claim heal.')
      }
      if (agentChoice) {
        // Resolve the absolute binary path once so the agent spawns even under
        // a restricted PATH (e.g. a Desktop-launched UI server).
        const agentBinary = resolveAgentBinary(agentChoice) ?? undefined
        try {
          autoHeal = {
            agent: agentChoice,
            buildSpawnCommand: ({ sessionId, resume, mcpOutputDir, promptFile }) => buildAgentSpawnCommand(agentChoice, {
              sessionId,
              resume,
              mcpOutputDir,
              mcpConfigFile: path.join(runDir, 'mcp-config.json'),
              promptFile,
              binaryPath: agentBinary,
            }),
            buildCyclePrompt: buildOrchestratorHealPrompt({
              agent: agentChoice,
              projectRoot: projectRoot,
              runDir,
              personalWikiPath: projectConfig.personalWikiPath,
            }),
          }
        } catch (err) {
          runnerLog.warn(`Auto-heal disabled: ${(err as Error).message}`)
        }
      } else if (!isBoot) {
        runnerLog.warn('Auto-heal disabled: no `claude` or `codex` CLI on PATH (set CANARY_LAB_HEAL_AGENT=claude|codex to override).')
      }

      const worktrees: WorktreeHandle[] = []
      for (const repoName of worktreeRepoNames) {
        const repo = (feature.repos ?? []).find((r) => r.name === repoName)
        if (!repo) continue
        try {
          const handle = await addWorktree({ repoName, localPath: repo.localPath, worktreesDir: path.join(runDir, 'worktrees') })
          // Git worktrees skip gitignored deps, so a fresh worktree has no
          // node_modules — the service boot command (`yarn start`, `npx tsx …`)
          // can't resolve its bins/deps and dies (e.g. `concurrently: command
          // not found`, exit 127), which then reads as a health-check timeout.
          // Symlink the source repo's node_modules in, exactly like the
          // benchmark and portify worktree paths already do.
          linkNodeModules(handle)
          // R80: reproduce the user's uncommitted edits in the worktree so an
          // always-worktree run tests their WIP, not just HEAD. A portified run's
          // intended tree state is its overlay (applied at boot), so skip it
          // there; boot sessions don't heal, so there's nothing to preserve.
          if (!portified && !isBoot) {
            const h = await hydrateWorkingTreeDiff(handle)
            if (h.error) {
              runnerLog.warn(`Worktree WIP hydration for "${repoName}" had issues (testing committed state): ${h.error}`)
            } else if (h.trackedApplied || h.untrackedCopied > 0) {
              runnerLog.info(`Hydrated uncommitted changes into "${repoName}" worktree (${h.untrackedCopied} untracked file(s)).`)
            }
          }
          worktrees.push(handle)
          runnerLog.info(`Isolated repo "${repoName}" in a per-run worktree.`)
        } catch (err) {
          // A portified run MUST have a worktree for every repo — without one
          // its overlay can't apply and it would boot un-portified (EADDRINUSE
          // on a concurrent boot). Fail loud instead of silently running bare.
          if (portified) {
            if (backups) restore(backups)
            throw new Error(`worktree isolation failed for portified repo "${repoName}": ${(err as Error).message}`)
          }
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
          executionType,
          // A boot-only session never runs tests, so it never heals — force all
          // heal modes off regardless of project config.
          autoHeal: isBoot ? undefined : autoHeal,
          manualHeal:
            !isBoot && !externalOrigin && projectConfig.healAgent === 'manual',
          externalHeal: !isBoot && (externalOrigin || projectConfig.healAgent === 'external'),
          externalHealSession,
          repoBranchSnapshots,
          // Route every manifest/index write through RunStore so its event
          // emitter sees the mutation. Phase 2 attaches the WS endpoint to
          // these events.
          runStateSink: runStore,
          dirtySpecHooks: dirtySpecStore,
          projectRoot,
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
      if (canClaim && healAgentReq) {
        externalHealBroker.claim(runId, {
          sessionId: healAgentReq.sessionId,
          clientKind: healAgentReq.clientKind,
          ...(healAgentReq.clientVersion ? { clientVersion: healAgentReq.clientVersion } : {}),
          ...(healAgentReq.conversationName ? { conversationName: healAgentReq.conversationName } : {}),
        })
      }

      attachRunStreams(orch, runnerLog, feature.name, backups)
      const broker = brokers.get(runId)!
      if (isBoot) {
        // Boot-only: boot + hold. On success do NOT stop — the services stay up
        // and the run stays an active registry entry until the user/agent hits
        // Stop/abort, which runs orch.stop() → tears services down → fires
        // run-complete → reverts the envset (see attachRunStreams). Only the
        // failure path (health timeout, etc.) tears down here.
        orch.bootOnly()
          .catch(async (err) => {
            broker.push('agent', `\n[boot error] ${String(err)}\n`)
            await orch.stop('aborted').catch(() => {})
            registry.delete(orch.runId)
          })
      } else {
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
      }
        // Register synchronously so the scheduler's next fit() / promotion sees
        // this run as active before any await yields.
        registry.set(orch.runId, orch)
        return orch
      }

      // Collision declined worktree → queue until the conflicting repo frees.
      if (collision && isolation === 'queue') {
        writeQueuedManifest(runId, feature, env, 'repo-collision', executionType)
        scheduler.enqueue({ runId, feature: feature.name, repoPaths: sourceRepoPaths, cost, reason: 'repo-collision', launch: async () => { await launch() } })
        return { kind: 'queued', runId, reason: 'repo-collision' }
      }
      // A PORTIFIED run allocates disjoint injected ports, so it never contends
      // with another run — it registers no repo paths (resources-only gating).
      // A plain run is now worktree-isolated too, but still binds the feature's
      // FIXED ports, so it must register its source repos so a concurrent
      // same-repo run trips the collision prompt (worktrees isolate the tree,
      // not the ports).
      const schedRepoPaths = portified ? [] : sourceRepoPaths
      const fit = scheduler.fits({ repoPaths: schedRepoPaths, cost })
      if (!fit.ok) {
        writeQueuedManifest(runId, feature, env, fit.reason, executionType)
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

      const projectConfig = loadProjectConfig(projectRoot)
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
          const agentBinary = resolveAgentBinary(agentChoice) ?? undefined
          try {
            autoHeal = {
              agent: agentChoice,
              buildSpawnCommand: ({ sessionId, resume, mcpOutputDir, promptFile }) => buildAgentSpawnCommand(agentChoice, {
                sessionId,
                resume,
                mcpOutputDir,
                mcpConfigFile: path.join(runDir, 'mcp-config.json'),
                promptFile,
                binaryPath: agentBinary,
              }),
              buildCyclePrompt: buildOrchestratorHealPrompt({
                agent: agentChoice,
                projectRoot: projectRoot,
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
          dirtySpecHooks: dirtySpecStore,
          projectRoot,
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
    restartHeal: restartLocalHeal,
  }
}
