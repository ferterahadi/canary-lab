import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { coverageRoutes } from './routes/coverage'
import { verificationRoutes } from './routes/verification'
import { runsRoutes, type ExternalHealAgentRequest } from '../runs/routes/runs'
import { testsDraftRoutes, type TestsDraftRouteDeps } from '../wizard/routes/tests-draft'
import { externalHealRoutes, makeExternalHealAuditLogger } from '../runs/routes/external-heal'
import { type OrchestratorLike } from '../runs/logic/run-store'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from '../benchmark/logic/runtime/skills'
import {
  buildAgentSessionResponse,
  resolveWorkflowAgentRef,
} from '../agent-sessions/logic/agent-session-log'
import { applyFeatureEnvset } from '../runs/logic/runtime/run-primitives'
import type { ServerContext } from '../../server-context'
import type { RunsFeature } from '../runs/index'
import { getInstalledPackageName, getInstalledPackageVersion } from '../../../../../shared/runtime/upgrade-check'
import { loadFeatures } from '../../shared/feature-loader'
import { generateRunId } from '../runs/logic/runtime/run-id'
import { runDirFor, buildRunPaths } from '../runs/logic/runtime/run-paths'
import { RunOrchestrator } from '../runs/logic/runtime/orchestrator'
import { RunScheduler, type SchedulerActiveRun } from '../runs/logic/runtime/run-scheduler'
import { estimateRunCost, resolveAdmissionConfig, readSystemResources } from '../runs/logic/runtime/admission'
import { detectRepoCollision, normalizeRepoPaths } from '../runs/logic/runtime/repo-collision'
import { addWorktree, hydrateWorkingTreeDiff, linkNodeModules, type WorktreeHandle } from '../runs/logic/runtime/repo-worktree'
import {
  buildAgentSpawnCommand,
  buildOrchestratorHealPrompt,
  pickAvailableHealAgent,
  resolveAgentBinary,
  type BuildHealCyclePrompt,
  type HealAgent,
} from '../runs/logic/runtime/auto-heal'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from '../../shared/git-repo'
import { RunnerLog } from '../runs/logic/runtime/runner-log'
import { realPtyFactory, type PtyFactory } from '../runs/logic/runtime/pty-spawner'
import {
  restore,
} from '../runs/logic/runtime/env-switcher/switch'
import type { BackupRecord } from '../runs/logic/runtime/env-switcher/types'
import {
  buildVerificationDiagnostics,
  resolveVerificationRun,
  type ResolveVerificationInput,
} from './logic/verification'

/**
 * Requirement coverage and deployed-environment verification. `startVerification` builds a verification orchestrator that both the REST route and the flight adapters drive.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext, runs: RunsFeature) {
  const { attachRunStreams } = runs
  const {
    projectRoot,
    featuresDir,
    logsDir,
    registry,
    runStore,
    coverageJobStore,
    flightStore,
    dirtySpecStore,
    workspaceEvents,
    brokers,
    ptyFactory,
  } = ctx

  await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: projectRoot, coverageJobStore, flightStore, workspaceEvents })
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
        dirtySpecHooks: dirtySpecStore,
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
    workspaceEvents,
  })
}
