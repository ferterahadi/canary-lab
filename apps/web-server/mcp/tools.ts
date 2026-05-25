import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../lib/run-store'
import type { RunDetail, RunStoreEvent } from '../lib/run-store'
import type { ExternalHealBroker } from '../lib/external-heal-broker'
import { loadFeatures } from '../lib/feature-loader'
import { runDirFor, buildRunPaths } from '../lib/runtime/run-paths'
import { buildHealPromptMap } from '../lib/runtime/auto-heal'
import { loadProjectConfig } from '../lib/runtime/launcher/project-config'
import {
  createVerificationConfig,
  getVerificationConfig,
  listVerificationConfigs,
  updateVerificationConfig,
  type ResolveVerificationInput,
} from '../lib/verification'
import {
  isActiveRunStatus,
  isTerminalRunStatus,
  deriveRunActionAvailability,
} from '../../../shared/run-state'

// Every Canary Lab MCP tool is a thin wrapper around an existing internal
// helper or REST handler. The translation pattern: validate input via zod,
// call the helper, format the result as a CallToolResult.
//
// Confirmation gates: destructive tools (abort_run, delete_run, etc.) require
// `confirm: true` literally in the input schema so a misbehaving model can't
// invoke them by accident.

export interface CanaryLabMcpDeps {
  store: RunStore
  broker: ExternalHealBroker
  featuresDir: string
  projectRoot: string
  startRun: (
    feature: string,
    env?: string,
    healAgent?: {
      kind: 'external'
      sessionId: string
      clientKind: 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-desktop' | 'other'
      clientVersion?: string
      conversationName?: string
    },
  ) => Promise<{ runId: string }>
  restartExternalRun?: (
    runId: string,
    healAgent: {
      kind: 'external'
      sessionId: string
      clientKind: 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-desktop' | 'other'
      clientVersion?: string
      conversationName?: string
    },
    guidance?: string,
  ) => Promise<{ runId: string; mode?: 'remaining' }>
  startVerification?: (
    feature: string,
    input: ResolveVerificationInput,
  ) => Promise<{ runId: string }>
}

const CLIENT_KIND = z.enum(['claude-cli', 'claude-desktop', 'codex-cli', 'codex-desktop', 'other'])
const SIGNAL_KIND = z.enum(['rerun', 'restart', 'heal'])
const HEAL_STATUS = z.enum(['connected', 'waiting', 'healing', 'running-tests', 'paused', 'disconnected'])
const WAIT_FOR_HEAL_TASK_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const WAIT_FOR_HEAL_TASK_MAX_TIMEOUT_MS = 60 * 60 * 1000

export const CANARY_LAB_MCP_PROFILES = ['repair', 'verify', 'full'] as const
export type CanaryLabMcpProfile = typeof CANARY_LAB_MCP_PROFILES[number]

export type CanaryLabMcpToolName =
  | 'list_features'
  | 'list_runs'
  | 'get_run'
  | 'get_run_actions'
  | 'list_verification_configs'
  | 'get_verification_config'
  | 'create_verification_config'
  | 'update_verification_config'
  | 'execute_verification'
  | 'get_verification_result'
  | 'get_heal_context'
  | 'start_run'
  | 'pause_run'
  | 'cancel_heal'
  | 'abort_run'
  | 'claim_heal'
  | 'release_heal'
  | 'heartbeat'
  | 'wait_for_heal_task'
  | 'signal_run'
  | 'write_journal'

const REPAIR_TOOLS = [
  'list_features',
  'list_runs',
  'start_run',
  'wait_for_heal_task',
  'get_heal_context',
  'get_run',
  'write_journal',
  'signal_run',
  'heartbeat',
  'pause_run',
  'cancel_heal',
  'abort_run',
] as const satisfies readonly CanaryLabMcpToolName[]

const VERIFY_TOOLS = [
  'list_features',
  'list_runs',
  'get_run',
  'list_verification_configs',
  'get_verification_config',
  'create_verification_config',
  'update_verification_config',
  'execute_verification',
  'get_verification_result',
] as const satisfies readonly CanaryLabMcpToolName[]

const FULL_TOOLS = [
  'list_features',
  'list_runs',
  'get_run',
  'get_run_actions',
  'list_verification_configs',
  'get_verification_config',
  'create_verification_config',
  'update_verification_config',
  'execute_verification',
  'get_verification_result',
  'get_heal_context',
  'start_run',
  'pause_run',
  'cancel_heal',
  'abort_run',
  'claim_heal',
  'release_heal',
  'heartbeat',
  'wait_for_heal_task',
  'signal_run',
  'write_journal',
] as const satisfies readonly CanaryLabMcpToolName[]

const TOOLS_BY_PROFILE: Record<CanaryLabMcpProfile, readonly CanaryLabMcpToolName[]> = {
  repair: REPAIR_TOOLS,
  verify: VERIFY_TOOLS,
  full: FULL_TOOLS,
}

export function isCanaryLabMcpProfile(value: string | undefined): value is CanaryLabMcpProfile {
  return !!value && (CANARY_LAB_MCP_PROFILES as readonly string[]).includes(value)
}

export function normalizeCanaryLabMcpProfile(value: string | undefined): CanaryLabMcpProfile | null {
  if (!value) return 'repair'
  return isCanaryLabMcpProfile(value) ? value : null
}

export function toolsForCanaryLabMcpProfile(profile: CanaryLabMcpProfile): readonly CanaryLabMcpToolName[] {
  return TOOLS_BY_PROFILE[profile]
}

export interface CanaryLabMcpToolOptions {
  profile?: CanaryLabMcpProfile
}

export function registerCanaryLabTools(
  server: McpServer,
  deps: CanaryLabMcpDeps,
  opts: CanaryLabMcpToolOptions = {},
): void {
  const profile = opts.profile ?? 'repair'
  const enabled = new Set<CanaryLabMcpToolName>(TOOLS_BY_PROFILE[profile])
  const knownTools = new Set<CanaryLabMcpToolName>(FULL_TOOLS)
  const registerTool: McpServer['registerTool'] = ((name: string, config: unknown, cb: unknown) => {
    const toolName = name as CanaryLabMcpToolName
    if (!knownTools.has(toolName)) {
      throw new Error(`MCP tool is not assigned to a profile: ${name}`)
    }
    if (enabled.has(toolName)) {
      const register = server.registerTool as unknown as (toolName: string, toolConfig: unknown, callback: unknown) => unknown
      register.call(server, name, config, cb)
    }
  }) as McpServer['registerTool']

  // ─── reads ────────────────────────────────────────────────────────────

  registerTool('list_features', {
    description: 'List every Canary Lab feature in the workspace, with envs, repos, and a short summary.',
    inputSchema: {},
  }, async () => {
    const features = loadFeatures(deps.featuresDir).map((f) => ({
      name: f.name,
      description: f.description ?? '',
      envs: f.envs ?? [],
      repos: (f.repos ?? []).map((r) => ({ name: r.name, localPath: r.localPath, branch: r.branch ?? null })),
    }))
    return asJsonResult(features)
  })

  registerTool('list_runs', {
    description: 'List Canary Lab runs, newest first. Optionally filter by feature.',
    inputSchema: {
      feature: z.string().optional().describe('Feature name. Omit to list across all features.'),
    },
  }, async ({ feature }) => {
    return asJsonResult(deps.store.list(feature ? { feature } : {}))
  })

  registerTool('get_run', {
    description: 'Fetch the full detail for one run: manifest, summary, lifecycle events, playwright artifacts.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    return asJsonResult(detail)
  })

  registerTool('get_run_actions', {
    description: 'Which actions are valid right now for a run (pauseHeal, stop, cancelHeal, delete, restartHeal, signal kinds, evaluation export).',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    const status = detail.manifest.status
    return asJsonResult({
      status,
      availability: deriveRunActionAvailability(status, null),
      signal: { rerun: isActiveRunStatus(status), restart: isActiveRunStatus(status), heal: isActiveRunStatus(status) },
      evaluationExport: { available: isTerminalRunStatus(status) },
      externalClaim: deps.broker.getSession(runId),
    })
  })

  registerTool('list_verification_configs', {
    description: 'List saved Verify configurations for a Canary Lab feature.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
    },
  }, async ({ featureId }) => {
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === featureId)
    if (!feature) return errorResult(`feature not found: ${featureId}`)
    return asJsonResult(listVerificationConfigs(feature))
  })

  registerTool('get_verification_config', {
    description: 'Fetch one saved Verify configuration for a Canary Lab feature.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
      configId: z.string().describe('Verification config id.'),
    },
  }, async ({ featureId, configId }) => {
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === featureId)
    if (!feature) return errorResult(`feature not found: ${featureId}`)
    const config = getVerificationConfig(feature, configId)
    if (!config) return errorResult(`verification config not found: ${configId}`)
    return asJsonResult(config)
  })

  registerTool('create_verification_config', {
    description: 'Create a saved Verify configuration for a feature.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
      name: z.string().describe('Configuration name, e.g. Beta or Staging.'),
      targetUrls: z.record(z.string(), z.string()).describe('Target URLs keyed by verification target id.'),
      playwrightEnvsetId: z.string().describe('Playwright envset to apply for verification.'),
    },
  }, async ({ featureId, name, targetUrls, playwrightEnvsetId }) => {
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === featureId)
    if (!feature) return errorResult(`feature not found: ${featureId}`)
    try {
      return asJsonResult(createVerificationConfig(feature, { name, targetUrls, playwrightEnvsetId }))
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('update_verification_config', {
    description: 'Update a saved Verify configuration for a feature.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
      configId: z.string().describe('Verification config id.'),
      name: z.string().describe('Configuration name, e.g. Beta or Staging.'),
      targetUrls: z.record(z.string(), z.string()).describe('Target URLs keyed by verification target id.'),
      playwrightEnvsetId: z.string().describe('Playwright envset to apply for verification.'),
    },
  }, async ({ featureId, configId, name, targetUrls, playwrightEnvsetId }) => {
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === featureId)
    if (!feature) return errorResult(`feature not found: ${featureId}`)
    try {
      const config = updateVerificationConfig(feature, configId, { name, targetUrls, playwrightEnvsetId })
      if (!config) return errorResult(`verification config not found: ${configId}`)
      return asJsonResult(config)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('execute_verification', {
    description: 'Execute Verify for a deployed environment. This never starts local services and never starts healing.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
      configId: z.string().optional().describe('Saved verification config id.'),
      targetUrls: z.record(z.string(), z.string()).optional().describe('Target URLs keyed by verification target id.'),
      playwrightEnvsetId: z.string().optional().describe('Playwright envset to apply for verification.'),
    },
  }, async ({ featureId, configId, targetUrls, playwrightEnvsetId }) => {
    if (!deps.startVerification) return errorResult('startVerification dependency is not configured')
    try {
      const started = await deps.startVerification(featureId, {
        ...(configId ? { configId } : {}),
        ...(targetUrls ? { targetUrls } : {}),
        ...(playwrightEnvsetId ? { playwrightEnvsetId } : {}),
      })
      const detail = deps.store.get(started.runId)
      if (!detail) {
        return asJsonResult({
          executionId: started.runId,
          executionType: 'verify',
          status: 'queued',
          targetUrls: targetUrls ?? {},
          playwrightEnvsetId: playwrightEnvsetId ?? '',
        })
      }
      return asJsonResult(verificationResult(detail))
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_verification_result', {
    description: 'Retrieve Verify result and diagnostics for a verification execution.',
    inputSchema: {
      executionId: z.string().describe('Verification execution id.'),
    },
  }, async ({ executionId }) => {
    const detail = deps.store.get(executionId)
    if (!detail) return errorResult(`verification result not found: ${executionId}`)
    if ((detail.manifest.executionType ?? 'run') !== 'verify') {
      return errorResult(`execution is not verify: ${executionId}`)
    }
    return asJsonResult(verificationResult(detail))
  })

  registerTool('get_heal_context', {
    description: 'Bundle of failure context an external heal agent needs: failed tests with artifact URLs, heal-index markdown, journal, repo branches, lifecycle.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
    },
  }, async ({ runId, session_id }) => {
    const context = buildHealContext(deps, runId)
    if (!context) return errorResult(`run not found: ${runId}`)
    if (session_id) deps.broker.touch(runId, session_id)
    return asJsonResult(context)
  })

  // ─── run lifecycle ────────────────────────────────────────────────────

  registerTool('start_run', {
    description:
      'Smart entrypoint for Canary Lab runs. If a matching run is healing, this returns that run and blocks fresh/different starts until `cancel_heal` stops it. If `runId` or `run_ref` targets a failed/aborted run and no heal is active, this restarts that same run in remaining-test mode: failed first, then skipped, then pending/not-run. Otherwise it starts a new run. After code changes, call `write_journal`, `signal_run`, then `wait_for_heal_task` on the same run.',
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      env: z.string().optional().describe('Envset name. Defaults to the feature\'s first declared env.'),
      runId: z.string().optional().describe('Optional exact run id to resume or restart. If a different run is currently healing, the active heal blocks this request.'),
      run_ref: z.string().optional().describe('Optional exact run id or unique suffix such as "7cvh" to resume or restart. If a different run is currently healing, the active heal blocks this request.'),
      claim_heal: z.boolean().default(true).describe('Whether to claim this run\'s heal duty for the current MCP session.'),
      session_id: z.string().describe('Stable id identifying this MCP/agent session. Reuse the same id across calls within one conversation to enable reconnects.'),
      client_kind: CLIENT_KIND.default('other').describe('Which kind of client is starting the run.'),
      conversation_name: z.string().optional().describe('Human label shown in the Canary Lab UI (e.g. "fix checkout").'),
      guidance: z.string().optional().describe('Optional user guidance when restarting a failed/aborted run by runId or run_ref.'),
      force_new: z.boolean().default(false).describe('Deprecated for MCP clients. If a matching run is healing, this is blocked until `cancel_heal` stops that run.'),
    },
  }, async ({ feature, env, runId, run_ref, claim_heal, session_id, client_kind, conversation_name, guidance, force_new }) => {
    try {
      const requestedRef = runId ?? run_ref
      const healing = findHealingRunForFeature(deps, feature, env)
      if (healing) {
        const requested = requestedRef ? resolveRunRef(deps, feature, env, requestedRef) : null
        if (force_new || (requested && (requested.kind !== 'resolved' || requested.detail.manifest.runId !== healing.manifest.runId))) {
          return asJsonResult({
            type: 'active_heal_blocks_start',
            activeRunId: healing.manifest.runId,
            activeStatus: healing.manifest.status,
            ...(requestedRef ? { requestedRunRef: requestedRef } : {}),
            ...(requested?.kind === 'resolved' ? { requestedRunId: requested.detail.manifest.runId } : {}),
            message: 'A matching run is already healing. Stop it first with cancel_heal before starting fresh or rerunning another run.',
          })
        }
        const claim = claim_heal ? claimRun(deps, healing.manifest.runId, session_id, client_kind, conversation_name) : null
        return asJsonResult({
          runId: healing.manifest.runId,
          reused: true,
          status: healing.manifest.status,
          claimed: claim_heal ? claim?.accepted === true : false,
          claim,
          ...(force_new
            ? {
                ignoredForceNew: true,
                warning: 'A matching run is already healing. Continue it with write_journal, signal_run, and wait_for_heal_task, or stop it first with cancel_heal.',
              }
            : {}),
        })
      }
      if (requestedRef) {
        const resolved = resolveRunRef(deps, feature, env, requestedRef)
        if (resolved.kind === 'missing') return errorResult(`run-not-found: ${requestedRef}`)
        if (resolved.kind === 'ambiguous') {
          return asJsonResult({
            type: 'ambiguous_run_ref',
            run_ref: requestedRef,
            candidates: resolved.candidates.map(runCandidate),
          })
        }
        const target = resolved.detail
        const status = target.manifest.status
        if (isActiveRunStatus(status)) {
          const claim = claim_heal ? claimRun(deps, target.manifest.runId, session_id, client_kind, conversation_name) : null
          return asJsonResult({
            runId: target.manifest.runId,
            reused: true,
            status,
            claimed: claim_heal ? claim?.accepted === true : false,
            claim,
          })
        }
        if (status === 'passed') {
          return asJsonResult({
            type: 'not_restartable',
            runId: target.manifest.runId,
            status,
            message: 'Passed runs are not restarted by start_run. Start a fresh run without runId/run_ref if you want to test again.',
          })
        }
        if (status !== 'failed' && status !== 'aborted') {
          return errorResult(`run-not-restartable: ${target.manifest.runId} status=${status}`)
        }
        if (!deps.restartExternalRun) return errorResult('restartExternalRun dependency is not configured')
        const restarted = await deps.restartExternalRun(
          target.manifest.runId,
          {
            kind: 'external',
            sessionId: session_id,
            clientKind: client_kind,
            ...(conversation_name ? { conversationName: conversation_name } : {}),
          },
          guidance,
        )
        const claim = claim_heal ? claimRun(deps, restarted.runId, session_id, client_kind, conversation_name) : null
        const counts = normalizeRunCounts(target.summary ?? null)
        return asJsonResult({
          runId: restarted.runId,
          reused: true,
          restarted: true,
          mode: restarted.mode ?? 'remaining',
          statusLine: counts.statusLine,
          counts,
          status: 'running',
          claimed: claim_heal ? claim?.accepted === true : false,
          claim,
        })
      }
      const result = await deps.startRun(
        feature,
        env,
        claim_heal
          ? {
              kind: 'external',
              sessionId: session_id,
              clientKind: client_kind,
              ...(conversation_name ? { conversationName: conversation_name } : {}),
            }
          : undefined,
      )
      return asJsonResult({ runId: result.runId, reused: false, claimed: claim_heal })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('pause_run', {
    description: 'Pause an active run and jump into heal mode immediately.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const orch = deps.store.registry.get(runId)
    if (!orch) return errorResult(`run not active: ${runId}`)
    const result = await orch.pauseAndHeal()
    if (!result.ok) return errorResult(`could not pause: ${result.reason}`)
    return asJsonResult({ status: 'healing', failureCount: result.failureCount })
  })

  registerTool('cancel_heal', {
    description: 'Cancel an in-flight heal cycle. Run transitions to failed.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const orch = deps.store.registry.get(runId)
    if (!orch) return errorResult(`run not active: ${runId}`)
    const result = await orch.cancelHeal()
    if (!result.ok) return errorResult(`could not cancel: ${result.reason}`)
    return asJsonResult({ status: 'cancelled' })
  })

  registerTool('abort_run', {
    description:
      'Hard-abort an active run. Requires `confirm: true` because this kills Playwright + services and cannot be undone.',
    inputSchema: {
      runId: z.string(),
      confirm: z.literal(true).describe('Must be true. Guard against accidental aborts.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ runId }) => {
    const result = await deps.store.abort(runId)
    if (!result.ok) return errorResult(`could not abort: ${result.reason}`)
    return asJsonResult({ aborted: true, runId })
  })

  // ─── external heal flow ───────────────────────────────────────────────

  registerTool('claim_heal', {
    description:
      'Claim heal duty for a run as this external session. Idempotent if the same session_id is already the holder; rejected with already-claimed if a different session holds it.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string(),
      client_kind: CLIENT_KIND.default('other'),
      client_version: z.string().optional(),
      conversation_name: z.string().optional(),
    },
  }, async ({ runId, session_id, client_kind, client_version, conversation_name }) => {
    if (!deps.store.get(runId)) return errorResult(`run not found: ${runId}`)
    const result = deps.broker.claim(runId, {
      sessionId: session_id,
      clientKind: client_kind,
      ...(client_version ? { clientVersion: client_version } : {}),
      ...(conversation_name ? { conversationName: conversation_name } : {}),
    })
    if (!result.accepted) {
      return errorResult(`already-claimed by session ${result.currentSession.sessionId} (${result.currentSession.clientKind})`)
    }
    return asJsonResult({ accepted: true, session: result.session })
  })

  registerTool('release_heal', {
    description: 'Release a heal claim. No-op if the session_id does not match the current holder.',
    inputSchema: { runId: z.string(), session_id: z.string() },
  }, async ({ runId, session_id }) => {
    const result = deps.broker.release(runId, session_id)
    return asJsonResult({ released: result.released })
  })

  registerTool('heartbeat', {
    description: 'Refresh the external heal session liveness. Sessions auto-disconnect after 10 minutes without any MCP traffic; any signal_run / write_journal / get_heal_context call also refreshes liveness, so you usually do not need to call this explicitly during normal healing.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string(),
      status: HEAL_STATUS.default('connected'),
    },
  }, async ({ runId, session_id, status }) => {
    const result = deps.broker.heartbeat(runId, session_id, status)
    if (!result.ok) return errorResult(`heartbeat rejected: ${result.reason}`)
    return asJsonResult({ ok: true, session: result.session })
  })

  registerTool('wait_for_heal_task', {
    description:
      'Wait until a claimed external run needs code fixes, reaches a terminal result, or times out. Use this after start_run/claim_heal and again after signal_run.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string().describe('External heal session id that owns this run.'),
      timeout_ms: z.number().int().positive().max(WAIT_FOR_HEAL_TASK_MAX_TIMEOUT_MS)
        .default(WAIT_FOR_HEAL_TASK_DEFAULT_TIMEOUT_MS)
        .describe('How long to wait. Defaults to 15 minutes and is capped at 60 minutes.'),
    },
  }, async ({ runId, session_id, timeout_ms }) => {
    const result = await waitForHealTask(deps, runId, session_id, timeout_ms)
    return result.ok ? asJsonResult(result.value) : errorResult(result.error)
  })

  registerTool('signal_run', {
    description:
      'Write a heal-cycle signal. The orchestrator picks it up via its existing poll loop. Use `rerun` for test-only fixes (no service restart) and `restart` when services need to be restarted.',
    inputSchema: {
      runId: z.string(),
      kind: SIGNAL_KIND,
      session_id: z.string().optional().describe('Required when the run holds an external claim; must match the claim holder.'),
      reason: z.string().optional().describe('Short note for the journal.'),
      files_changed: z.array(z.string()).optional().describe('Paths of files modified during this heal cycle, relative to repo roots.'),
    },
  }, async ({ runId, kind, session_id, reason, files_changed }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (!isActiveRunStatus(detail.manifest.status)) {
      return errorResult(`run not active (status=${detail.manifest.status})`)
    }
    const ownership = deps.broker.assertOwnership(runId, session_id)
    if (!ownership.ok && ownership.reason === 'session-mismatch') {
      return errorResult(`session-mismatch: run is held by ${ownership.currentSession?.sessionId}`)
    }
    if (session_id) deps.broker.touch(runId, session_id)
    const paths = buildRunPaths(runDirFor(deps.store.logsDir, runId))
    const target = kind === 'restart' ? paths.restartSignal
      : kind === 'rerun' ? paths.rerunSignal
      : paths.healSignal
    const body = {
      ...(reason ? { reason } : {}),
      ...(files_changed && files_changed.length > 0 ? { filesChanged: files_changed } : {}),
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify(body))
    } catch (err) {
      return errorResult(`could not write signal: ${(err as Error).message}`)
    }
    deps.broker.bumpCycle(runId)
    return asJsonResult({ accepted: true, kind, path: target })
  })

  registerTool('write_journal', {
    description: 'Append a diagnosis note to the run\'s journal. Useful for recording what an external heal cycle attempted.',
    inputSchema: {
      runId: z.string(),
      iteration: z.number().int().min(1).describe('Heal cycle number this note belongs to.'),
      body: z.string().describe('Markdown note body. The journal is human-readable.'),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
    },
  }, async ({ runId, iteration, body, session_id }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    const runDir = runDirFor(deps.store.logsDir, runId)
    const journalPath = buildRunPaths(runDir).diagnosisJournalPath
    const hypothesis = extractJournalLine(body, 'Hypothesis') ?? firstJournalLine(body)
    const fixDescription = extractJournalLine(body, 'Fix')
    const section = [
      `## Iteration ${iteration} — ${new Date().toISOString()}`,
      '',
      `- run: ${runId}`,
      `- feature: ${detail.manifest.feature}`,
      ...(hypothesis ? [`- hypothesis: ${truncateJournalField(hypothesis)}`] : []),
      ...(fixDescription ? [`- fix.description: ${truncateJournalField(fixDescription)}`] : []),
      '- outcome: pending',
      '',
      body.trimEnd(),
      '',
    ].join('\n')
    try {
      fs.mkdirSync(path.dirname(journalPath), { recursive: true })
      const prefix = fs.existsSync(journalPath) ? '\n' : '# Diagnosis Journal\n\n'
      fs.appendFileSync(journalPath, prefix + section)
    } catch (err) {
      return errorResult(`could not append journal: ${(err as Error).message}`)
    }
    if (session_id) deps.broker.touch(runId, session_id)
    return asJsonResult({ appended: true, path: journalPath })
  })
}

// ─── result helpers ─────────────────────────────────────────────────────

function extractJournalLine(body: string, label: string): string | null {
  const re = new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, 'i')
  for (const line of body.split('\n')) {
    const match = re.exec(line)
    if (match) return match[1].trim()
  }
  return null
}

function firstJournalLine(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.replace(/^\s*Hypothesis:\s*/i, '').trim()
  }
  return null
}

function truncateJournalField(value: string, max = 400): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`
}

type ClaimResult = { accepted: true; session: unknown } | { accepted: false; reason: string; currentSession: unknown }

function claimRun(
  deps: CanaryLabMcpDeps,
  runId: string,
  sessionId: string,
  clientKind: z.infer<typeof CLIENT_KIND>,
  conversationName: string | undefined,
): ClaimResult {
  const result = deps.broker.claim(runId, {
    sessionId,
    clientKind,
    ...(conversationName ? { conversationName } : {}),
  })
  return result.accepted
    ? { accepted: true, session: result.session }
    : { accepted: false, reason: result.reason, currentSession: result.currentSession }
}

function findHealingRunForFeature(
  deps: CanaryLabMcpDeps,
  feature: string,
  env: string | undefined,
): RunDetail | null {
  const candidates: Array<{ detail: RunDetail; startedAt: string }> = []
  for (const entry of deps.store.list({ feature })) {
    if (entry.status !== 'healing') continue
    const detail = deps.store.get(entry.runId)
    if (!detail) continue
    if (env && detail.manifest.env !== env) continue
    candidates.push({ detail, startedAt: entry.startedAt })
  }
  candidates.sort((a, b) => {
    const priorityDiff = activeRunPriority(a.detail) - activeRunPriority(b.detail)
    if (priorityDiff !== 0) return priorityDiff
    return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
  })
  return candidates[0]?.detail ?? null
}

function activeRunPriority(detail: RunDetail): number {
  if (detail.manifest.lifecycle?.phase === 'waiting-for-signal') return 0
  if (detail.manifest.status === 'healing') return 1
  return 2
}

type RunRefResolution =
  | { kind: 'resolved'; detail: RunDetail }
  | { kind: 'ambiguous'; candidates: RunDetail[] }
  | { kind: 'missing' }

function resolveRunRef(
  deps: CanaryLabMcpDeps,
  feature: string,
  env: string | undefined,
  ref: string,
): RunRefResolution {
  const matches: RunDetail[] = []
  for (const entry of deps.store.list({ feature })) {
    const detail = deps.store.get(entry.runId)
    if (!detail) continue
    if (env && detail.manifest.env !== env) continue
    if (detail.manifest.runId === ref || detail.manifest.runId.endsWith(ref)) {
      matches.push(detail)
    }
  }
  if (matches.length === 0) return { kind: 'missing' }
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches }
  return { kind: 'resolved', detail: matches[0] }
}

function runCandidate(detail: RunDetail): Record<string, unknown> {
  return {
    runId: detail.manifest.runId,
    executionType: detail.manifest.executionType ?? 'run',
    feature: detail.manifest.feature,
    env: detail.manifest.env ?? null,
    status: detail.manifest.status,
    startedAt: detail.manifest.startedAt,
    endedAt: detail.manifest.endedAt ?? null,
  }
}

function verificationResult(detail: RunDetail): Record<string, unknown> {
  const verification = detail.manifest.verification
  return {
    executionId: detail.manifest.runId,
    executionType: 'verify',
    status: mcpVerificationStatus(detail.manifest.status),
    ...(verification?.configName ? { configName: verification.configName } : {}),
    targetUrls: verification?.targetUrls ?? {},
    playwrightEnvsetId: verification?.playwrightEnvsetId ?? detail.manifest.env ?? '',
    ...(verification?.diagnostics ? { diagnostics: verification.diagnostics } : {}),
  }
}

function mcpVerificationStatus(status: string): string {
  if (status === 'aborted') return 'cancelled'
  return status
}

function buildHealContext(deps: CanaryLabMcpDeps, runId: string): Record<string, unknown> | null {
  const detail = deps.store.get(runId)
  if (!detail) return null
  const runDir = runDirFor(deps.store.logsDir, runId)
  const paths = buildRunPaths(runDir)
  const summary = detail.summary
  const projectConfig = loadProjectConfig(deps.projectRoot)
  const failedTests = (summary?.failed ?? []).map((entry) => ({
    name: entry.name,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.location ? { location: entry.location } : {}),
    ...(typeof entry.retry === 'number' ? { retry: entry.retry } : {}),
    artifacts:
      detail.playwrightArtifacts
        ?.find((g) => g.testName === entry.name)
        ?.artifacts.map((a) => ({ name: a.name, kind: a.kind, url: a.url })) ?? [],
  }))
  return {
    runId,
    feature: detail.manifest.feature,
    env: detail.manifest.env ?? null,
    status: detail.manifest.status,
    healCycles: detail.manifest.healCycles,
    repoBranches: detail.manifest.repoBranches ?? [],
    lifecycle: detail.manifest.lifecycle ?? null,
    externalHealSession: detail.manifest.externalHealSession ?? null,
    summary: summary ?? null,
    counts: normalizeRunCounts(summary ?? null),
    failedTests,
    healIndexMarkdown: safeRead(paths.healIndexPath),
    journalMarkdown: safeRead(paths.diagnosisJournalPath),
    artifactsBase: `/api/runs/${encodeURIComponent(runId)}/artifacts/`,
    healPrompt: buildHealPromptMap({
      projectRoot: deps.projectRoot,
      runDir,
      personalWikiPath: projectConfig.personalWikiPath,
    }),
  }
}

interface NormalizedRunCounts {
  totalKnown: number
  passed: number
  failed: number
  skipped: number
  notRun: number
  passedNames: string[]
  failedNames: string[]
  skippedNames: string[]
  notRunNames: string[]
  statusLine: string
}

function normalizeRunCounts(summary: RunDetail['summary'] | null): NormalizedRunCounts {
  const summaryWithKnownTests = summary as (RunDetail['summary'] & { knownTests?: unknown }) | null
  const knownTests = Array.isArray(summaryWithKnownTests?.knownTests)
    ? summaryWithKnownTests.knownTests
    : []
  const knownNames = uniqueStrings(knownTests.map((entry) => {
    if (!entry || typeof entry !== 'object') return ''
    const name = (entry as { name?: unknown }).name
    return typeof name === 'string' ? name : ''
  }))
  const passedNames = uniqueStrings(summary?.passedNames ?? [])
  const failedNames = uniqueStrings((summary?.failed ?? []).map((entry) => entry.name))
  const skippedNames = uniqueStrings(summary?.skippedNames ?? [])
  const accounted = new Set([...passedNames, ...failedNames, ...skippedNames])
  const notRunNames = knownNames.filter((name) => !accounted.has(name))
  const totalKnown = knownNames.length > 0 ? knownNames.length : numberOrZero(summary?.total)
  const passed = typeof summary?.passed === 'number' ? summary.passed : passedNames.length
  const failed = failedNames.length
  const skipped = typeof summary?.skipped === 'number' ? summary.skipped : skippedNames.length
  const notRun = knownNames.length > 0
    ? notRunNames.length
    : Math.max(0, totalKnown - passed - failed - skipped)

  return {
    totalKnown,
    passed,
    failed,
    skipped,
    notRun,
    passedNames,
    failedNames,
    skippedNames,
    notRunNames,
    statusLine: statusLineForCounts({ totalKnown, passed, failed, skipped, notRun }),
  }
}

function statusLineForCounts(counts: Pick<NormalizedRunCounts, 'totalKnown' | 'passed' | 'failed' | 'skipped' | 'notRun'>): string {
  const parts = [`${counts.passed}/${counts.totalKnown} passed`, `${counts.failed} failed`]
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`)
  parts.push(`${counts.notRun} not run`)
  return parts.join(', ')
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

type WaitForHealTaskValue =
  | { type: 'needs_heal'; runId: string; cycle: number; context: Record<string, unknown> }
  | { type: 'passed'; runId: string; summary: RunDetail['summary'] | null; counts: NormalizedRunCounts }
  | { type: 'failed'; runId: string; status: string; summary: RunDetail['summary'] | null; counts: NormalizedRunCounts }
  | { type: 'timeout'; runId: string; status: string | null; lifecycle: RunDetail['manifest']['lifecycle'] | null }

type WaitForHealTaskResult =
  | { ok: true; value: WaitForHealTaskValue }
  | { ok: false; error: string }

function classifyWaitForHealTask(
  deps: CanaryLabMcpDeps,
  runId: string,
  sessionId: string,
): WaitForHealTaskResult | null {
  const detail = deps.store.get(runId)
  if (!detail) return { ok: false, error: `run not found: ${runId}` }

  const status = detail.manifest.status
  if (status === 'passed') {
    return {
      ok: true,
      value: {
        type: 'passed',
        runId,
        summary: detail.summary ?? null,
        counts: normalizeRunCounts(detail.summary ?? null),
      },
    }
  }
  if (isTerminalRunStatus(status)) {
    return {
      ok: true,
      value: {
        type: 'failed',
        runId,
        status,
        summary: detail.summary ?? null,
        counts: normalizeRunCounts(detail.summary ?? null),
      },
    }
  }

  const ownership = deps.broker.assertOwnership(runId, sessionId)
  if (!ownership.ok) {
    return {
      ok: false,
      error: ownership.reason === 'session-mismatch'
        ? `session-mismatch: run is held by ${ownership.currentSession?.sessionId}`
        : `no external heal claim for run: ${runId}`,
    }
  }

  if (
    isActiveRunStatus(status) &&
    detail.manifest.healMode === 'external' &&
    detail.manifest.lifecycle?.phase === 'waiting-for-signal'
  ) {
    const context = buildHealContext(deps, runId)
    if (!context) return { ok: false, error: `run not found: ${runId}` }
    return {
      ok: true,
      value: {
        type: 'needs_heal',
        runId,
        cycle: detail.manifest.lifecycle.activeCycle ?? detail.manifest.healCycles,
        context,
      },
    }
  }

  return null
}

async function waitForHealTask(
  deps: CanaryLabMcpDeps,
  runId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<WaitForHealTaskResult> {
  const immediate = classifyWaitForHealTask(deps, runId, sessionId)
  if (immediate) return immediate

  return await new Promise<WaitForHealTaskResult>((resolve) => {
    let settled = false
    const finish = (result: WaitForHealTaskResult): void => {
      if (settled) return
      settled = true
      deps.store.offEvent(onEvent)
      clearTimeout(timeout)
      clearInterval(heartbeat)
      resolve(result)
    }
    const check = (): void => {
      const result = classifyWaitForHealTask(deps, runId, sessionId)
      if (result) finish(result)
    }
    const onEvent = (event: RunStoreEvent): void => {
      if (event.runId && event.runId !== runId) return
      check()
    }
    const beat = (): void => {
      const detail = deps.store.get(runId)
      if (!detail || isTerminalRunStatus(detail.manifest.status)) return
      deps.broker.heartbeat(runId, sessionId, 'waiting')
    }
    deps.store.onEvent(onEvent)
    const timeout = setTimeout(() => {
      const detail = deps.store.get(runId)
      finish({
        ok: true,
        value: {
          type: 'timeout',
          runId,
          status: detail?.manifest.status ?? null,
          lifecycle: detail?.manifest.lifecycle ?? null,
        },
      })
    }, timeoutMs)
    const heartbeat = setInterval(beat, 5_000)
    if (typeof timeout.unref === 'function') timeout.unref()
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    beat()
    check()
  })
}

function asJsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function safeRead(file: string): string | null {
  try { return fs.readFileSync(file, 'utf-8') } catch { return null }
}
