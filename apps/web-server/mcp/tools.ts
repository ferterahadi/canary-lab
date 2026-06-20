import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../src/features/orchestration/logic/run-store'
import type { RunDetail, RunStoreEvent } from '../src/features/orchestration/logic/run-store'
import type { ExternalHealBroker } from '../src/features/external-heal/logic/external-heal-broker'
import type { ExternalHealClientKind } from '../src/features/orchestration/logic/runtime/manifest'
import {
  buildExternalFailureDetail,
  buildExternalHealContext,
  buildExternalRunSnapshot,
  normalizeRunCounts,
  writeHealSignal,
  type ExternalHealContext,
  type NormalizedRunCounts,
} from '../src/features/external-heal/logic/external-heal-surface'
import { loadFeatures } from '../src/features/orchestration/logic/feature-loader'
import { isHealClaimAllowed } from '../src/features/external-heal/logic/heal-claim-policy'
import { computePortPreflight } from '../src/features/orchestration/logic/runtime/port-preflight'
import {
  createVerificationConfig,
  getVerificationConfig,
  listVerificationConfigs,
  updateVerificationConfig,
  type ResolveVerificationInput,
} from '../src/features/coverage/logic/verification'
import {
  applyExternalDraftFiles,
  captureFeatureEnvFiles,
  checkoutFeatureRepoBranch,
  createFeatureSkeleton,
  deleteFeature,
  getFeatureEnvsetSummary,
  getFeatureRepoStatus,
  writeFeatureDoc,
  deleteFeatureDoc,
  type EnvFileSource,
} from '../src/features/orchestration/logic/feature-authoring'
import {
  FeatureNotFoundError,
  clearPrdSummary,
  computeFeatureCoverage,
  featureExists,
  listFeatureDocs,
  regeneratePrdSummary,
} from '../src/features/coverage/logic/coverage/service'
import { CoverageJobRunStore } from '../src/features/coverage/logic/coverage/jobs/store'
import { startCoverageJob, CoverageJobConflictError } from '../src/features/coverage/logic/coverage/jobs/runner'
import {
  createDraft,
  paths as draftPaths,
  readDraft,
  writeDraft,
  type DraftRecord,
  type ExternalDraftStage,
} from '../src/features/evaluation-artifacts/logic/draft-store'
import {
  appendEvaluationExportLog,
  createEvaluationExportTask,
  deleteEvaluationExportTask,
  evaluationExportTaskView,
  listEvaluationExportTasks,
  patchEvaluationExportTask,
  readEvaluationExportTask,
  readEvaluationExportZip,
  writeEvaluationExportZip,
  type EvaluationExportTaskRecord,
} from '../src/features/evaluation-artifacts/logic/evaluation-export-store'
import { buildEvaluationExportArchive } from '../src/features/evaluation-artifacts/logic/evaluation-export-archive'
import {
  applyEvaluationTextSlotRewrite,
  buildTestReviewPacket,
  deterministicEvaluationRewrite,
  evaluationTextSlots,
  normalizeEvaluationRewrite,
  type EvaluationRewrite,
} from '../src/features/evaluation-artifacts/logic/test-review-export'
import {
  isActiveRunStatus,
  isTerminalRunStatus,
  deriveRunActionAvailability,
} from '../../../shared/run-state'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../src/features/orchestration/logic/workspace-events'
import type { PortifyManifest } from '../src/features/orchestration/logic/runtime/portify/types'
import { overlayExists as portifyOverlayExists } from '../src/features/orchestration/logic/runtime/portify/overlay'

// Every Canary Lab MCP tool is a thin wrapper around an existing internal
// helper or REST handler. The translation pattern: validate input via zod,
// call the helper, format the result as a CallToolResult.
//
// Confirmation gates: destructive tools (abort_run, delete_run, etc.) require
// `confirm: true` literally in the input schema so a misbehaving model can't
// invoke them by accident.

const evaluationTextSlotInput = z.object({
  id: z.string(),
  text: z.string(),
})

const evaluationRewriteInput = z.object({
  formatVersion: z.number().optional(),
  featureTitle: z.string().optional(),
  summary: z.string(),
  cases: z.array(z.object({
    title: z.string(),
    whatWasChecked: z.string(),
    whyItMatters: z.string(),
    confidence: z.string(),
    flowSteps: z.array(z.object({
      title: z.string(),
      detail: z.string().optional(),
    })).optional(),
  })),
})

/** Result of an MCP-driven start request under concurrency. */
export type McpStartRunOutcome =
  | { kind: 'started'; runId: string }
  | { kind: 'queued'; runId: string; reason: 'resources' | 'repo-collision' }
  | {
      kind: 'collision'
      conflictingRunId: string
      conflictingFeature: string
      repoPaths: string[]
      options: Array<'worktree' | 'queue'>
      message: string
    }

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
      claimable?: boolean
    },
    isolation?: 'worktree' | 'queue',
    executionType?: 'run' | 'boot',
  ) => Promise<McpStartRunOutcome>
  restartExternalRun?: (
    runId: string,
    healAgent: {
      kind: 'external'
      sessionId: string
      clientKind: 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-desktop' | 'other'
      clientVersion?: string
      conversationName?: string
      claimable?: boolean
    },
    guidance?: string,
  ) => Promise<{ runId: string; mode?: 'remaining' }>
  startVerification?: (
    feature: string,
    input: ResolveVerificationInput,
  ) => Promise<{ runId: string }>
  /** PUT /api/features/:name/envsets/:env/:slot — overwrites a slot file's
   *  parsed entries. Provided as a dep so MCP `write_envset` can reuse the
   *  REST handler's path-traversal and feature-resolution checks. */
  writeEnvsetSlot?: (
    feature: string,
    env: string,
    slot: string,
    entries: Array<{ key: string; value: string }>,
  ) => Promise<{ path: string; entries: Array<{ key: string; value: string }>; unparsedLines: number[] }>
  /** POST /api/runs/:runId/heal-agent/handoff — swap heal mode away from
   *  external. Mirrors the REST handler so MCP `handoff_heal` doesn't
   *  re-implement the broker + restart wiring. */
  handoffHeal?: (
    runId: string,
    to: 'auto' | 'claude' | 'codex' | 'manual',
    sessionId: string | undefined,
    guidance: string | undefined,
  ) => Promise<{ statusCode: number; body: unknown }>
  /** Port-ification workflow (make a feature's apps use injectable ports).
   *  These reuse the in-process portify runner + store behind routes/portify.ts;
   *  the start/save/cancel calls throw with a `statusCode` the tools surface. */
  startPortify?: (feature: string, agent?: 'claude' | 'codex', maxAttempts?: number) => Promise<{ workflowId: string }>
  getPortify?: (workflowId: string) => PortifyManifest | null
  savePortify?: (workflowId: string) => Promise<PortifyManifest>
  cancelPortify?: (workflowId: string) => Promise<PortifyManifest>
  revisePortify?: (workflowId: string, feedback: string) => Promise<PortifyManifest>
  workspaceEvents?: WorkspaceEventPublisher
}

const CLIENT_KIND = z.enum(['claude-cli', 'claude-desktop', 'codex-cli', 'codex-desktop', 'other'])
const SIGNAL_KIND = z.enum(['rerun', 'restart', 'heal'])
const HEAL_STATUS = z.enum(['connected', 'waiting', 'healing', 'running-tests', 'paused', 'disconnected'])
const EXTERNAL_DRAFT_STAGE = z.enum(['scaffolding', 'authoring-tests', 'validating', 'ready', 'applied', 'error'])
const CLAIM_SUPPRESSED_MESSAGE =
  'Heal claiming is restricted to Claude/Codex Desktop clients, so this run was started without a heal claim. It still runs — drive heal from Desktop or the web UI.'
// `timeout_ms` is the per-call block budget — how long ONE wait_for_heal_task
// request may hold open. It is NOT the overall heal budget: when the window
// elapses with the run still active, the call returns `still_waiting` and the
// agent immediately re-calls. This keeps every request well under any client
// JSON-RPC request timeout (the cause of the -32001 the long-poll used to hit),
// while the logical wait stays unbounded across re-calls.
const WAIT_FOR_HEAL_TASK_DEFAULT_TIMEOUT_MS = 90 * 1000
const WAIT_FOR_HEAL_TASK_MAX_TIMEOUT_MS = 60 * 60 * 1000
// Hard cap on a single block regardless of the requested timeout_ms. Large
// requested values are clamped to this (not rejected) so older clients keep
// working — they just get a `still_waiting` to loop on sooner.
const WAIT_FOR_HEAL_TASK_WINDOW_MS = 120 * 1000

export const CANARY_LAB_MCP_PROFILES = ['repair', 'verify', 'author', 'full'] as const
export type CanaryLabMcpProfile = typeof CANARY_LAB_MCP_PROFILES[number]

export type CanaryLabMcpToolName =
  | 'list_features'
  | 'list_runs'
  | 'get_run'
  | 'get_run_snapshot'
  | 'get_run_actions'
  | 'list_verification_configs'
  | 'get_verification_config'
  | 'create_verification_config'
  | 'update_verification_config'
  | 'execute_verification'
  | 'get_verification_result'
  | 'create_feature'
  | 'write_feature_doc'
  | 'delete_feature_doc'
  | 'get_feature_coverage'
  | 'list_feature_docs'
  | 'regenerate_prd_summary'
  | 'clear_prd_summary'
  | 'start_coverage_job'
  | 'get_coverage_job'
  | 'get_feature_envset_summary'
  | 'capture_feature_env_files'
  | 'write_envset'
  | 'delete_feature'
  | 'get_feature_repo_status'
  | 'checkout_feature_repo_branch'
  | 'start_external_evaluation_export'
  | 'submit_external_evaluation_export'
  | 'list_evaluation_exports'
  | 'get_evaluation_export'
  | 'download_evaluation_export'
  | 'delete_evaluation_export'
  | 'start_external_draft'
  | 'update_external_draft_stage'
  | 'apply_external_draft'
  | 'get_heal_context'
  | 'get_failure_detail'
  | 'start_run'
  | 'boot_services'
  | 'pause_run'
  | 'cancel_heal'
  | 'abort_run'
  | 'claim_heal'
  | 'release_heal'
  | 'heartbeat'
  | 'wait_for_heal_task'
  | 'signal_run'
  | 'handoff_heal'
  | 'start_portify'
  | 'get_portify'
  | 'save_portify'
  | 'cancel_portify'
  | 'revise_portify'
  | 'list_portify_status'

const REPAIR_TOOLS = [
  'list_features',
  'list_runs',
  'start_run',
  'boot_services',
  'wait_for_heal_task',
  'get_heal_context',
  'get_failure_detail',
  'get_run_snapshot',
  'get_run',
  'signal_run',
  'heartbeat',
  'pause_run',
  'cancel_heal',
  'abort_run',
  'handoff_heal',
] as const satisfies readonly CanaryLabMcpToolName[]

const VERIFY_TOOLS = [
  'list_features',
  'list_runs',
  'get_run',
  'boot_services',
  'abort_run',
  'list_verification_configs',
  'get_verification_config',
  'create_verification_config',
  'update_verification_config',
  'execute_verification',
  'get_verification_result',
] as const satisfies readonly CanaryLabMcpToolName[]

const AUTHOR_TOOLS = [
  'list_features',
  'list_runs',
  'get_run',
  'get_run_snapshot',
  'create_feature',
  'write_feature_doc',
  'delete_feature_doc',
  'get_feature_coverage',
  'list_feature_docs',
  'regenerate_prd_summary',
  'clear_prd_summary',
  'start_coverage_job',
  'get_coverage_job',
  'get_feature_envset_summary',
  'capture_feature_env_files',
  'write_envset',
  'delete_feature',
  'get_feature_repo_status',
  'checkout_feature_repo_branch',
  'start_external_evaluation_export',
  'submit_external_evaluation_export',
  'list_evaluation_exports',
  'get_evaluation_export',
  'download_evaluation_export',
  'delete_evaluation_export',
  'start_external_draft',
  'update_external_draft_stage',
  'apply_external_draft',
  'start_portify',
  'get_portify',
  'save_portify',
  'cancel_portify',
  'revise_portify',
  'list_portify_status',
] as const satisfies readonly CanaryLabMcpToolName[]

// Tools that exist only in the `full` profile — everything else is composed
// from the per-workflow profiles above.
const FULL_ONLY_TOOLS = [
  'get_run_actions',
  'claim_heal',
  'release_heal',
] as const satisfies readonly CanaryLabMcpToolName[]

// `full` is the deduplicated union of every profile plus the full-only tools.
// Defining it as a union means adding a tool to any profile surfaces it in
// `full` automatically — no second edit, no drift, no duplicate entries.
const FULL_TOOLS: readonly CanaryLabMcpToolName[] = Array.from(
  new Set<CanaryLabMcpToolName>([
    ...REPAIR_TOOLS,
    ...VERIFY_TOOLS,
    ...AUTHOR_TOOLS,
    ...FULL_ONLY_TOOLS,
  ]),
)

const TOOLS_BY_PROFILE: Record<CanaryLabMcpProfile, readonly CanaryLabMcpToolName[]> = {
  repair: REPAIR_TOOLS,
  verify: VERIFY_TOOLS,
  author: AUTHOR_TOOLS,
  full: FULL_TOOLS,
}

export function isCanaryLabMcpProfile(value: string | undefined): value is CanaryLabMcpProfile {
  return !!value && (CANARY_LAB_MCP_PROFILES as readonly string[]).includes(value)
}

export function normalizeCanaryLabMcpProfile(value: string | undefined): CanaryLabMcpProfile | null {
  if (!value) return 'full'
  return isCanaryLabMcpProfile(value) ? value : null
}

export function toolsForCanaryLabMcpProfile(profile: CanaryLabMcpProfile): readonly CanaryLabMcpToolName[] {
  return TOOLS_BY_PROFILE[profile]
}

export interface CanaryLabMcpToolOptions {
  profile?: CanaryLabMcpProfile
  defaultClientKind?: ExternalHealClientKind
}

export function registerCanaryLabTools(
  server: McpServer,
  deps: CanaryLabMcpDeps,
  opts: CanaryLabMcpToolOptions = {},
): void {
  const profile = opts.profile ?? 'full'
  const defaultClientKind = opts.defaultClientKind ?? 'other'
  const clientKindInput = CLIENT_KIND.default(defaultClientKind)
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
    description: 'List existing Canary Lab features when you need to choose or inspect one. Do not call this before random/new feature creation; call create_feature directly with a unique name and retry on collision.',
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

  registerTool('get_run_snapshot', {
    description: 'Fetch the verbose external-heal run snapshot: summary, full counts, failed tests, heal index, journal, artifact base, and heal prompt map.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    return asJsonResult(buildExternalRunSnapshot({
      detail,
      logsDir: deps.store.logsDir,
      projectRoot: deps.projectRoot,
    }))
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

  // ─── external authoring and export control ───────────────────────────

  registerTool('create_feature', {
    description: 'Create a Canary Lab feature skeleton for an external client to author tests. This never generates test cases or starts a local Claude/Codex agent.',
    inputSchema: {
      feature: z.string().describe('Feature name to create under features/<name>.'),
      description: z.string().optional(),
      envs: z.array(z.string()).optional().describe('Envset names to declare. Defaults to local.'),
      repos: z.array(z.object({
        name: z.string(),
        localPath: z.string(),
        cloneUrl: z.string().optional(),
        branch: z.string().optional(),
        startCommands: z.array(z.unknown()).optional(),
        envs: z.array(z.string()).optional(),
      })).optional(),
      envSources: z.array(z.object({
        sourcePath: z.string(),
        env: z.string().optional(),
        slot: z.string().optional(),
        target: z.string().optional(),
        description: z.string().optional(),
        confirmOverwrite: z.boolean().optional(),
      })).optional().describe('Optional env/config files to copy into feature envsets. Values are never returned.'),
    },
  }, async ({ feature, description, envs, repos, envSources }) => {
    try {
      const created = createFeatureSkeleton({
        projectRoot: deps.projectRoot,
        featuresDir: deps.featuresDir,
        feature,
        description,
        envs,
        repos,
      })
      if (!created.ok) return errorResult(created.error)
      const captured = envSources?.length
        ? captureFeatureEnvFiles({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, { feature, sources: envSources as EnvFileSource[] })
        : null
      if (captured && !captured.ok) return errorResult(captured.error)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-created', feature })
      if (captured?.ok) publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature })
      return asJsonResult({
        ...created,
        ...(captured?.ok ? { captured: captured.captured, envsets: captured.summary } : {}),
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('write_feature_doc', {
    description:
      'Write a prose doc (distilled session, plan, notes) into a feature\'s docs/ directory — the home for feature-scoped documentation. Create-or-replace: pick a descriptive relPath (e.g. "2026-05-28-line-integration-notes.md"); re-writing the same path overwrites. Markdown only (.md/.markdown). Use this for "add this plan/distillation to feature <name>".',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      relPath: z.string().describe('Path relative to the feature docs/ dir, e.g. "notes.md" or "sessions/2026-05-28.md". A leading "docs/" is optional. Must end in .md or .markdown.'),
      content: z.string().describe('Markdown document body.'),
    },
  }, async ({ feature, relPath, content }) => {
    const result = writeFeatureDoc(
      { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
      { feature, relPath, content },
    )
    if (!result.ok) return errorResult(result.error)
    return asJsonResult({ written: true, path: result.writtenPath, relativePath: result.relativePath })
  })

  registerTool('delete_feature_doc', {
    description:
      'Delete a SOURCE doc from a feature\'s docs/ directory (the UI Docs-tab pill\'s remove action). Refuses generated artifacts (the _prd-* / _coverage-* files canary manages). After removing docs, regenerate the PRD summary so coverage reflects the change.',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      relPath: z.string().describe('Path of the source doc relative to docs/, e.g. "notes.md". A leading "docs/" is optional.'),
    },
  }, async ({ feature, relPath }) => {
    const result = deleteFeatureDoc(
      { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
      { feature, relPath },
    )
    if (!result.ok) return errorResult(result.error)
    return asJsonResult({ deleted: true, relativePath: result.relativePath })
  })

  registerTool('get_feature_coverage', {
    description:
      'Get the Verified Coverage Ledger for a feature: PRD requirements → annotated tests → last passing run + gap type (untested / unverified / path-incomplete / verified / shallow-verified) with a grounded coverage %, PLUS per-requirement rigor (tierReached / tierAvailable / strictness / weakestAssertion / suggestedStrongerCheck) and docs-drift status. The coverage % and strictness are evidence-based math over passing runs — never an opinion. Use this to find untested/unverified requirements and to see which passing tests are too lax (and what stronger check to write).',
    inputSchema: { feature: z.string().describe('Existing feature name (from list_features).') },
  }, async ({ feature }) => {
    try {
      return asJsonResult(computeFeatureCoverage({
        featuresDir: deps.featuresDir,
        logsDir: deps.store.logsDir,
        feature,
      }))
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      throw err
    }
  })

  registerTool('list_feature_docs', {
    description:
      'List the docs in a feature\'s docs/ directory (source docs the user added plus generated _prd-* PRD artifacts), with the PRD summary status and docs-drift flag. The UI Docs tab shows the same list — use this to see what source material the PRD summary was built from before regenerating it.',
    inputSchema: { feature: z.string().describe('Existing feature name (from list_features).') },
  }, async ({ feature }) => {
    try {
      return asJsonResult(listFeatureDocs(deps.featuresDir, feature))
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      throw err
    }
  })

  registerTool('regenerate_prd_summary', {
    description:
      'Regenerate a feature\'s PRD summary from its current source docs (after you add or edit docs with write_feature_doc, or when get_feature_coverage reports docsDrift). Existing requirement ids are PRESERVED so inline @requirement annotations keep resolving; new requirements get new ids, removed ones are marked deprecated. Writes docs/_prd-summary.{json,md}. Same action as the UI Docs-tab "Regenerate" button.',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      adapter: z.enum(['auto', 'claude', 'codex', 'deterministic']).optional()
        .describe('Summarizer backend. Omit for auto (prefers an available agent CLI, falls back to deterministic heading extraction).'),
    },
  }, async ({ feature, adapter }) => {
    try {
      const result = await regeneratePrdSummary({
        featuresDir: deps.featuresDir,
        feature,
        adapter,
        cwd: deps.projectRoot,
      })
      return asJsonResult(result)
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      throw err
    }
  })

  registerTool('clear_prd_summary', {
    description:
      'Remove a feature\'s generated PRD summary and the coverage sidecars tied to it (pending mappings, run-state). Source docs are left untouched; the feature returns to the "no summary" state (and the whole surface to its initial empty state if no source docs remain). Same action as the UI Docs-tab ✕ on the generated summary card.',
    inputSchema: { feature: z.string().describe('Existing feature name (from list_features).') },
  }, async ({ feature }) => {
    try {
      return asJsonResult(clearPrdSummary({ featuresDir: deps.featuresDir, feature }))
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      throw err
    }
  })

  registerTool('start_coverage_job', {
    description:
      'Start an ASYNC background job for a feature: kind:"summary" regenerates the PRD summary from source docs (preserving requirement ids) AND then auto-chains the coverage engine (Summary + Coverage are one exercise); kind:"coverage" runs only the coverage engine — it infers which requirement(s) each untagged test verifies and writes the @req-* covers tag immediately (no review gate). Non-blocking and single-flight: a second job of the same kind for the same feature is rejected while one is running. A summary job records its chained coverage job id as chainedJobId. Poll get_coverage_job with the returned jobId. Same action as the UI Coverage dialog\'s Regenerate buttons.',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      kind: z.enum(['summary', 'coverage']).describe('summary = regenerate the PRD summary, then auto-run coverage; coverage = run only the annotate-pass engine.'),
      adapter: z.enum(['auto', 'claude', 'codex', 'deterministic']).optional()
        .describe('Agent backend. Omit for auto (prefers an available agent CLI, falls back to deterministic).'),
    },
  }, async ({ feature, kind, adapter }) => {
    if (!featureExists(deps.featuresDir, feature)) return errorResult(`feature not found: ${feature}`)
    try {
      const { manifest } = startCoverageJob(
        {
          featuresDir: deps.featuresDir,
          logsDir: deps.store.logsDir,
          feature,
          kind,
          adapter: adapter as never,
          cwd: deps.projectRoot,
        },
        { store: new CoverageJobRunStore(deps.store.logsDir) },
      )
      return asJsonResult(manifest)
    } catch (err) {
      if (err instanceof CoverageJobConflictError) return errorResult(`${err.message} (existing job ${err.existingJobId})`)
      throw err
    }
  })

  registerTool('get_coverage_job', {
    description:
      'Poll a coverage background job by jobId (from start_coverage_job). Returns the manifest: status (running / done / failed / aborted), captured log, chainedJobId (for a summary job, the coverage job it auto-started — poll that next to follow the full exercise), and on done a result summary (requirementCount for summary jobs; applied tag-write count for coverage jobs). Then call get_feature_coverage for the updated ledger.',
    inputSchema: { jobId: z.string().describe('Job id returned by start_coverage_job.') },
  }, async ({ jobId }) => {
    const manifest = new CoverageJobRunStore(deps.store.logsDir).get(jobId)
    if (!manifest) return errorResult(`job not found: ${jobId}`)
    return asJsonResult(manifest)
  })

  registerTool('get_feature_envset_summary', {
    description: 'List a feature envset layout, slot targets, and redacted key previews. Secret values are never returned.',
    inputSchema: { feature: z.string() },
  }, async ({ feature }) => {
    const summary = getFeatureEnvsetSummary({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, feature)
    if (!summary) return errorResult(`feature not found: ${feature}`)
    return asJsonResult(summary)
  })

  registerTool('capture_feature_env_files', {
    description: 'Copy declared .env/properties files into feature envsets and update envsets.config.json. Returns redacted key previews only.',
    inputSchema: {
      feature: z.string(),
      sources: z.array(z.object({
        sourcePath: z.string(),
        env: z.string().optional(),
        slot: z.string().optional(),
        target: z.string().optional(),
        description: z.string().optional(),
        confirmOverwrite: z.boolean().optional(),
      })).min(1),
    },
  }, async ({ feature, sources }) => {
    try {
      const result = captureFeatureEnvFiles({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, { feature, sources: sources as EnvFileSource[] })
      if (!result.ok) return errorResult(result.error)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return asJsonResult(result)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('write_envset', {
    description: 'Overwrite an envset slot file with the supplied key/value entries. Destructive — replaces existing keys and drops unparseable lines. Use capture_feature_env_files to bulk-copy from a source file instead.',
    inputSchema: {
      feature: z.string(),
      env: z.string().describe('Envset folder name, e.g. local or staging.'),
      slot: z.string().describe('Slot filename inside the envset, e.g. api.env or application.properties.'),
      entries: z.array(z.object({ key: z.string(), value: z.string() })).describe('Replacement key/value pairs. Empty array clears the file.'),
      confirm: z.literal(true).describe('Must be true. Guards against accidental envset overwrites.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ feature, env, slot, entries }) => {
    if (!deps.writeEnvsetSlot) return errorResult('writeEnvsetSlot dependency is not configured')
    try {
      const result = await deps.writeEnvsetSlot(feature, env, slot, entries)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature })
      return asJsonResult({ feature, env, slot, path: result.path, entries: result.entries, unparsedLines: result.unparsedLines })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('delete_feature', {
    description: 'Delete a Canary Lab feature directory. Requires confirmName to match the feature name.',
    inputSchema: {
      feature: z.string(),
      confirmName: z.string().describe('Must exactly match feature.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ feature, confirmName }) => {
    const result = deleteFeature({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, { feature, confirmName })
    if (!result.ok) return errorResult(result.error)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-deleted', feature })
    return asJsonResult({ deleted: true, feature, featureDir: result.featureDir })
  })

  registerTool('get_feature_repo_status', {
    description: 'Get git branch/dirty status for a repo declared in feature.config.cjs.',
    inputSchema: { feature: z.string(), repo: z.string() },
  }, async ({ feature, repo }) => {
    const status = await getFeatureRepoStatus({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, feature, repo)
    if (!status) return errorResult(`repo not found: ${feature}/${repo}`)
    return asJsonResult(status)
  })

  registerTool('checkout_feature_repo_branch', {
    description: 'Checkout a branch in a repo declared in feature.config.cjs. Confirm-gated because it changes the user repo checkout.',
    inputSchema: {
      feature: z.string(),
      repo: z.string(),
      branch: z.string(),
      confirm: z.literal(true),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ feature, repo, branch, confirm }) => {
    const result = await checkoutFeatureRepoBranch(
      { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
      { feature, repo, branch, confirm },
    )
    return isToolErrorPayload(result) ? errorResult(result.error) : asJsonResult(result)
  })

  registerTool('start_external_evaluation_export', {
    description: 'Create an evaluation export task for an external client to author. Returns run context plus the report/archive submission schema. Does not start any local LLM.',
    inputSchema: {
      runId: z.string(),
      language: z.string().default('English'),
      session_id: z.string(),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ runId, language, session_id, client_kind, conversation_name, external_session_url }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (!isTerminalRunStatus(detail.manifest.status)) {
      return errorResult('evaluation export is available after the run finishes')
    }
    const now = new Date().toISOString()
    const task: EvaluationExportTaskRecord = {
      taskId: newEvaluationTaskId(),
      runId,
      feature: detail.manifest.feature,
      mode: 'localized',
      producer: 'external',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      downloadReady: false,
      archiveBase: `canary-lab-evaluation-${safeFilename(detail.manifest.feature)}-${safeFilename(runId)}`,
      clientKind: client_kind,
      sessionId: session_id,
      ...(conversation_name ? { conversationName: conversation_name } : {}),
      language,
      ...(external_session_url ? { externalSessionUrl: external_session_url } : {}),
    }
    createEvaluationExportTask(deps.store.logsDir, task)
    appendEvaluationExportLog(deps.store.logsDir, task.taskId, '[evaluation] external export task created\n')
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-created', task: evaluationExportTaskView(task) })
    return asJsonResult({
      task: evaluationExportTaskView(task),
      runContext: buildExternalRunSnapshot({
        detail,
        logsDir: deps.store.logsDir,
        projectRoot: deps.projectRoot,
      }),
      reportSchema: externalEvaluationReportSchema(detail),
      nextSteps: ['author structured evaluation wording', 'submit_external_evaluation_export'],
    })
  })

  registerTool('submit_external_evaluation_export', {
    description: 'Render structured external evaluation wording through Canary Lab’s canonical HTML export and mark the task completed.',
    inputSchema: {
      taskId: z.string(),
      textSlots: z.array(evaluationTextSlotInput).optional(),
      rewrite: evaluationRewriteInput.optional(),
    },
  }, async ({ taskId, textSlots, rewrite }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    if ((task.producer ?? 'internal') !== 'external') return errorResult('only external export tasks can be submitted through this tool')
    if (!rewrite && (!textSlots || textSlots.length === 0)) return errorResult('submit textSlots[] or rewrite')
    const detail = deps.store.get(task.runId)
    if (!detail) return errorResult(`run not found: ${task.runId}`)
    try {
      const packet = buildTestReviewPacket(detail)
      const normalizedRewrite = rewrite
        ? normalizeEvaluationRewrite(rewrite as EvaluationRewrite, packet)
        : applyEvaluationTextSlotRewrite(deterministicEvaluationRewrite(packet), textSlots!)
      if (!normalizedRewrite) {
        return errorResult('rewrite must include one case for each evaluated test')
      }
      const built = await buildEvaluationExportArchive(detail, {
        logsDir: deps.store.logsDir,
        audienceAdapter: 'deterministic',
        rewrite: normalizedRewrite,
      })
      writeEvaluationExportZip(deps.store.logsDir, taskId, built.zip)
      appendEvaluationExportLog(deps.store.logsDir, taskId, '[evaluation] external report submitted\n')
      const next = patchEvaluationExportTask(deps.store.logsDir, taskId, {
        archiveBase: built.archiveBase,
        status: 'completed',
        downloadReady: true,
      })
      if (next) {
        publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-updated', task: evaluationExportTaskView(next) })
      }
      return asJsonResult({
        ...evaluationExportTaskView(next!),
        nextSteps: ['download_evaluation_export'],
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('list_evaluation_exports', {
    description: 'List persisted evaluation export tasks.',
    inputSchema: { runId: z.string().optional() },
  }, async ({ runId }) => {
    const tasks = listEvaluationExportTasks(deps.store.logsDir, runId ? { runId } : {})
    return asJsonResult(tasks.map(evaluationExportTaskView))
  })

  registerTool('get_evaluation_export', {
    description: 'Fetch one evaluation export task.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    return asJsonResult(evaluationExportTaskView(task))
  })

  registerTool('download_evaluation_export', {
    description: 'Return a completed evaluation export archive as base64 for MCP clients.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    const zip = task.status === 'completed' ? readEvaluationExportZip(deps.store.logsDir, taskId) : null
    if (!zip) return errorResult('evaluation export is not ready')
    return asJsonResult({
      task: evaluationExportTaskView(task),
      filename: `${task.archiveBase}.zip`,
      archiveBase64: zip.toString('base64'),
    })
  })

  registerTool('delete_evaluation_export', {
    description: 'Delete an evaluation export task and stored archive. Requires confirm: true.',
    inputSchema: { taskId: z.string(), confirm: z.literal(true) },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ taskId }) => {
    const deleted = deleteEvaluationExportTask(deps.store.logsDir, taskId)
    if (!deleted) return errorResult(`evaluation export task not found: ${taskId}`)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-deleted', taskId })
    return asJsonResult({ deleted: true, taskId })
  })

  registerTool('start_external_draft', {
    description: 'Create an external test-authoring draft/task record. This never starts the internal wizard agents.',
    inputSchema: {
      feature: z.string(),
      stage: EXTERNAL_DRAFT_STAGE.default('scaffolding'),
      session_id: z.string(),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ feature, stage, session_id, client_kind, conversation_name, external_session_url }) => {
    const featureConfig = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === feature)
    if (!featureConfig) return errorResult(`feature not found: ${feature}`)
    const draftId = newDraftId()
    const record = createDraft(deps.store.logsDir, {
      draftId,
      prdText: `External client is authoring tests for ${feature}.`,
      prdDocuments: [],
      repos: (featureConfig.repos ?? []).map((repo) => ({
        name: repo.name,
        localPath: repo.localPath,
        ...(repo.branch ? { branch: repo.branch } : {}),
      })),
      featureName: feature,
      source: 'external',
      externalStage: stage as ExternalDraftStage,
      externalClientKind: client_kind,
      externalSessionId: session_id,
      ...(conversation_name ? { externalConversationName: conversation_name } : {}),
      ...(external_session_url ? { externalSessionUrl: external_session_url } : {}),
    })
    const next: DraftRecord = {
      ...record,
      status: statusForExternalStage(stage as ExternalDraftStage),
      updatedAt: new Date().toISOString(),
    }
    writeDraft(deps.store.logsDir, next)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-created', draft: next })
    return asJsonResult({
      ...externalDraftView(next),
      canaryLabBehavior: 'tracking-only',
      statusMeaning: 'External client is authoring tests; Canary Lab is not running an internal wizard agent.',
      nextSteps: externalDraftAuthoringNextSteps(feature),
    })
  })

  registerTool('update_external_draft_stage', {
    description: 'Update the visible stage for an external draft/task record.',
    inputSchema: {
      draftId: z.string(),
      stage: EXTERNAL_DRAFT_STAGE,
      message: z.string().optional(),
    },
  }, async ({ draftId, stage, message }) => {
    const current = readDraft(deps.store.logsDir, draftId)
    if (!current) return errorResult(`draft not found: ${draftId}`)
    if ((current.source ?? 'internal') !== 'external') return errorResult('draft is not external-owned')
    const next: DraftRecord = {
      ...current,
      externalStage: stage as ExternalDraftStage,
      status: statusForExternalStage(stage as ExternalDraftStage),
      ...(stage === 'error' && message ? { errorMessage: message } : {}),
      updatedAt: new Date().toISOString(),
    }
    writeDraft(deps.store.logsDir, next)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-updated', draft: next })
    return asJsonResult(externalDraftView(next))
  })

  registerTool('apply_external_draft', {
    description: 'Validate externally authored test files and apply them to the target feature. Requires confirm: true. This never starts internal wizard agents.',
    inputSchema: {
      draftId: z.string(),
      confirm: z.literal(true),
      files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ draftId, files }) => {
    const current = readDraft(deps.store.logsDir, draftId)
    if (!current) return errorResult(`draft not found: ${draftId}`)
    if ((current.source ?? 'internal') !== 'external') return errorResult('draft is not external-owned')
    if (!current.featureName) return errorResult('external draft has no featureName')
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === current.featureName)
    if (!feature?.featureDir) return errorResult(`feature not found: ${current.featureName}`)
    const applied = applyExternalDraftFiles({
      featureDir: feature.featureDir,
      files: files?.map((file) => ({ path: file.path, content: file.content })),
    })
    if (!applied.ok) return errorResult(applied.error)
    const p = draftPaths(deps.store.logsDir, draftId)
    fs.mkdirSync(p.generatedDir, { recursive: true })
    for (const file of files ?? []) {
      const target = path.join(p.generatedDir, file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content, 'utf8')
    }
    const next: DraftRecord = {
      ...current,
      externalStage: 'applied',
      status: 'accepted',
      generatedFiles: applied.written,
      updatedAt: new Date().toISOString(),
    }
    writeDraft(deps.store.logsDir, next)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-updated', draft: next })
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: current.featureName })
    return asJsonResult({
      draftId,
      feature: current.featureName,
      status: 'applied',
      written: applied.written,
    })
  })

  // ── Port-ification (make a feature's apps use injectable ports) ──────────
  registerTool('start_portify', {
    description: "Start a port-ification workflow: an agent rewrites a feature's apps so every network listener reads an injected port, proven by booting the stack twice concurrently. The verified edits are saved as an EPHEMERAL OVERLAY (a captured patch under features/<feature>/portify/) — never committed or merged, so the product repo stays pristine; at run time the overlay is applied into a per-run worktree and reverse-applied at teardown. Async — returns a workflowId; poll get_portify, then save_portify once it is ready-to-save. One workflow at a time.",
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      agent: z.enum(['claude', 'codex']).optional().describe('Which CLI does the rewrite. Defaults to an available local agent.'),
      maxAttempts: z.number().int().positive().optional().describe('Edit→verify retries before giving up (default 3).'),
    },
  }, async ({ feature, agent, maxAttempts }) => {
    if (!deps.startPortify) return errorResult('startPortify dependency is not configured')
    try {
      const { workflowId } = await deps.startPortify(feature, agent, maxAttempts)
      return asJsonResult({
        workflowId,
        status: 'planning',
        nextSteps: ['get_portify'],
        next: `Poll get_portify with workflowId "${workflowId}" until status is "ready-to-save", then save_portify (or cancel_portify).`,
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_portify', {
    description: 'Read a port-ification workflow: status (planning/editing/verifying/ready-to-save/saved/failed/aborted), attempt count, the diff, and the double-boot verification result.',
    inputSchema: { workflowId: z.string() },
  }, async ({ workflowId }) => {
    if (!deps.getPortify) return errorResult('getPortify dependency is not configured')
    const manifest = deps.getPortify(workflowId)
    if (!manifest) return errorResult(`port-ification workflow not found: ${workflowId}`)
    return asJsonResult(manifest)
  })

  registerTool('list_portify_status', {
    description: "List every feature with whether it is PORTIFIED — i.e. has a saved port overlay (features/<feature>/portify/) so it can boot concurrently (benchmark arms / parallel runs) without an EADDRINUSE clash. `portified` is the source of truth: a VERIFIED overlay exists (proven by the double-boot at save time). `declaredSlots` lists the port slots each service/command declares (informational). Use it to see which features still need start_portify.",
    inputSchema: {},
  }, async () => {
    const features = loadFeatures(deps.featuresDir).map((f) => {
      const pf = computePortPreflight(f)
      return { feature: f.name, portified: portifyOverlayExists(f.featureDir), declaredSlots: pf.repos }
    })
    const portified = features.filter((f) => f.portified).length
    return asJsonResult({
      features,
      summary: { total: features.length, portified, notPortified: features.length - portified },
    })
  })

  registerTool('save_portify', {
    description: "Save a verified port-ification workflow as the feature's EPHEMERAL OVERLAY (captured patch under features/<feature>/portify/) and discard the scratch worktree — NOTHING is committed or merged; the product repo stays pristine. The overlay is applied into a fresh per-run worktree before each run and reverse-applied at teardown. Only valid when status is ready-to-save. Requires confirm: true.",
    inputSchema: {
      workflowId: z.string(),
      confirm: z.literal(true).describe('Must be true. Guards against saving an unreviewed rewrite.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ workflowId }) => {
    if (!deps.savePortify) return errorResult('savePortify dependency is not configured')
    try {
      const manifest = await deps.savePortify(workflowId)
      return asJsonResult({
        ...manifest,
        next: `Overlay saved to features/${manifest.feature}/portify/. The feature now boots with injectable ports on every run — concurrent runs and benchmark arms will not clash — without ever modifying the product repo.`,
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('revise_portify', {
    description: "Send review feedback to a ready-to-save port-ification workflow: the agent resumes its session, applies your adjustments (e.g. rename an env var, expose another port slot), and the stack is re-booted twice to re-verify. Async — the workflow returns to editing, then verifying, then ready-to-save; poll get_portify. Feedback rounds are unbounded and separate from the auto-retry budget. Only valid when status is ready-to-save.",
    inputSchema: {
      workflowId: z.string(),
      feedback: z.string().min(1).describe('Plain-language adjustments for the agent to apply to its port-ification diff.'),
    },
  }, async ({ workflowId, feedback }) => {
    if (!deps.revisePortify) return errorResult('revisePortify dependency is not configured')
    try {
      const manifest = await deps.revisePortify(workflowId, feedback)
      return asJsonResult({
        ...manifest,
        nextSteps: ['get_portify'],
        next: `Poll get_portify with workflowId "${workflowId}" until status is "ready-to-save" again, then save_portify (or revise_portify once more).`,
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('cancel_portify', {
    description: 'Cancel a port-ification workflow — discards its scratch worktree + branch and restores the feature config. Requires confirm: true.',
    inputSchema: {
      workflowId: z.string(),
      confirm: z.literal(true).describe('Must be true. Guards against discarding in-flight work.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ workflowId }) => {
    if (!deps.cancelPortify) return errorResult('cancelPortify dependency is not configured')
    try {
      return asJsonResult(await deps.cancelPortify(workflowId))
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_heal_context', {
    description: 'Compact failure handoff packet an external heal agent needs first: current failures, artifact URLs, heal-index, journal, repo branches, lifecycle, and heal prompt map. Use get_run_snapshot for verbose raw summary/debugging fields.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
      client_kind: clientKindInput.describe('Which kind of client is requesting context. Defaults to the MCP client type when known.'),
    },
  }, async ({ runId, session_id, client_kind }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (session_id) {
      ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    }
    const context = buildExternalHealContext({
      detail,
      logsDir: deps.store.logsDir,
      projectRoot: deps.projectRoot,
    })
    if (session_id) deps.broker.touch(runId, session_id)
    return asJsonResult(context)
  })

  registerTool('get_failure_detail', {
    description:
      'One failing test\'s bounded detail: error, location, resolved pointer dirs (trace-extract, playwright-mcp), plus the curated trace summary and full error text inlined (capped). Use `failureId` from a failedTests[] entry in get_heal_context / wait_for_heal_task. Built for fan-out: when several tests fail, hand each failureId to its own read-only sub-agent so they investigate in parallel without pulling the whole heal context each.',
    inputSchema: {
      runId: z.string(),
      failureId: z.string().describe('The failureId (== failed test name) from a failedTests[] entry.'),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
      client_kind: clientKindInput.describe('Which kind of client is requesting detail. Defaults to the MCP client type when known.'),
    },
  }, async ({ runId, failureId, session_id, client_kind }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (session_id) {
      ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    }
    const failure = buildExternalFailureDetail({ detail, logsDir: deps.store.logsDir, failureId })
    if (!failure) return errorResult(`failure not found: ${failureId} (use a failureId from failedTests[])`)
    if (session_id) deps.broker.touch(runId, session_id)
    return asJsonResult(failure)
  })

  // ─── run lifecycle ────────────────────────────────────────────────────

  registerTool('start_run', {
    description:
      'Smart entrypoint for Canary Lab runs. If a matching run is healing, this returns that run and blocks fresh/different starts until `cancel_heal` stops it. If `runId` or `run_ref` targets a failed/aborted run and no heal is active, this restarts that same run in remaining-test mode: failed first, then skipped, then pending/not-run. Otherwise it starts a new run. To retry a failed/aborted run, prefer this rerun path (pass `run_ref`) over `abort_run` + a fresh start — a fresh start re-runs the whole suite and is only worth it when prior passes are invalidated (e.g. a global data/state change). After code changes, call `signal_run` with hypothesis and fixDescription, then `wait_for_heal_task` on the same run.',
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      env: z.string().optional().describe('Envset name. Defaults to the feature\'s first declared env.'),
      runId: z.string().optional().describe('Optional exact run id to resume or restart. If a different run is currently healing, the active heal blocks this request.'),
      run_ref: z.string().optional().describe('Optional exact run id or unique suffix such as "7cvh" to resume or restart. If a different run is currently healing, the active heal blocks this request.'),
      claim_heal: z.boolean().default(true).describe('Whether to claim this run\'s heal duty for the current MCP session.'),
      session_id: z.string().describe('Stable id identifying this MCP/agent session. Reuse the same id across calls within one conversation to enable reconnects.'),
      client_kind: clientKindInput.describe('Which kind of client is starting the run. Defaults to the MCP client type when known.'),
      conversation_name: z.string().optional().describe('Human label shown in the Canary Lab UI (e.g. "fix checkout").'),
      guidance: z.string().optional().describe('Optional user guidance when restarting a failed/aborted run by runId or run_ref.'),
      force_new: z.boolean().default(false).describe('Start a fresh concurrent run even if a matching run is healing (it continues independently). A same-repo collision still asks you to choose isolation.'),
      isolation: z.enum(['worktree', 'queue']).optional().describe('Only needed after start_run returns repo_collision_requires_choice: "worktree" isolates this run in a per-run git worktree and starts it now (concurrent); "queue" waits until the conflicting run finishes.'),
    },
  }, async ({ feature, env, runId, run_ref, claim_heal, session_id, client_kind, conversation_name, guidance, force_new, isolation }) => {
    try {
      const requestedRef = runId ?? run_ref
      // Heal-claim policy: claiming is reserved for Desktop clients. A CLI (or
      // undetected 'other') client may still start/verify the run, but must not
      // own its heal loop — so we down-shift claim_heal to false and tell the
      // caller, instead of grabbing heal duty behind their back.
      const claimAllowed = claim_heal && isHealClaimAllowed(client_kind)
      const claimSuppressed = claim_heal && !claimAllowed
      const suppressionFields = claimSuppressed
        ? { claimSuppressed: true, message: CLAIM_SUPPRESSED_MESSAGE }
        : {}
      // Default (no explicit ref, no force_new): continue the run that's
      // already healing for this feature — the external-heal continuation
      // pattern. With concurrency, `force_new` (or targeting a different run)
      // no longer blocks: it falls through to a fresh concurrent start, where
      // same-repo collisions surface a worktree/queue choice.
      const healing = findHealingRunForFeature(deps, feature, env)
      if (healing && !force_new && !requestedRef) {
        const claim = claimAllowed ? claimRun(deps, healing.manifest.runId, session_id, client_kind, conversation_name) : null
        return asJsonResult({
          runId: healing.manifest.runId,
          reused: true,
          status: healing.manifest.status,
          claimed: claimAllowed ? claim?.accepted === true : false,
          claim,
          ...suppressionFields,
          ...(claimAllowed ? healWaitNext(healing.manifest.runId) : {}),
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
        if (isActiveBootRun(target)) {
          // Boot-only sessions hold services up with no tests and no heal loop.
          // Don't claim heal or tell the caller to wait_for_heal_task.
          return asJsonResult({ ...bootSessionValue(target), reused: true })
        }
        if (isActiveRunStatus(status)) {
          const claim = claimAllowed ? claimRun(deps, target.manifest.runId, session_id, client_kind, conversation_name) : null
          return asJsonResult({
            runId: target.manifest.runId,
            reused: true,
            status,
            claimed: claimAllowed ? claim?.accepted === true : false,
            claim,
            ...suppressionFields,
            ...(claimAllowed ? healWaitNext(target.manifest.runId) : {}),
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
        // Restarting a failed run re-enters external heal. A disallowed (CLI /
        // 'other') client may still trigger the restart — it just can't own the
        // loop: `claimable: false` restarts into external mode with no session
        // and no broker claim, so the run waits for a Desktop/UI drive rather
        // than silently restarting into a session the client owns.
        const restarted = await deps.restartExternalRun(
          target.manifest.runId,
          {
            kind: 'external',
            sessionId: session_id,
            clientKind: client_kind,
            ...(conversation_name ? { conversationName: conversation_name } : {}),
            claimable: claimAllowed,
          },
          guidance,
        )
        const claim = claimAllowed ? claimRun(deps, restarted.runId, session_id, client_kind, conversation_name) : null
        const counts = normalizeRunCounts(target.summary ?? null)
        return asJsonResult({
          runId: restarted.runId,
          reused: true,
          restarted: true,
          mode: restarted.mode ?? 'remaining',
          statusLine: counts.statusLine,
          counts,
          status: 'running',
          claimed: claimAllowed ? claim?.accepted === true : false,
          claim,
          ...suppressionFields,
          ...(claimAllowed ? healWaitNext(restarted.runId) : {}),
        })
      }
      // Any MCP-triggered run is external-origin: it must use External-client
      // heal regardless of the project's Heal Agent setting (which only governs
      // UI-triggered runs). `claimable` is what splits a Desktop client that
      // owns the loop from a CLI/'other' client that can't — the latter still
      // runs in external mode and waits for a Desktop/UI drive instead of
      // falling back to a locally-spawned auto-heal agent.
      const outcome = await deps.startRun(
        feature,
        env,
        {
          kind: 'external',
          sessionId: session_id,
          clientKind: client_kind,
          ...(conversation_name ? { conversationName: conversation_name } : {}),
          claimable: claimAllowed,
        },
        isolation,
      )
      if (outcome.kind === 'collision') {
        // Same-repo collision and the client didn't choose. Nothing started —
        // ask the user, then re-call start_run with isolation:"worktree"|"queue".
        return asJsonResult({
          type: 'repo_collision_requires_choice',
          conflictingRunId: outcome.conflictingRunId,
          conflictingFeature: outcome.conflictingFeature,
          repoPaths: outcome.repoPaths,
          options: outcome.options,
          message: outcome.message,
          nextSteps: ['ask_user_worktree_or_queue'],
        })
      }
      if (outcome.kind === 'queued') {
        return asJsonResult({
          runId: outcome.runId,
          reused: false,
          queued: true,
          queueReason: outcome.reason,
          claimed: claimAllowed,
          ...suppressionFields,
          ...(claimAllowed ? healWaitNext(outcome.runId) : {}),
        })
      }
      return asJsonResult({
        runId: outcome.runId,
        reused: false,
        claimed: claimAllowed,
        ...suppressionFields,
        ...(claimAllowed ? healWaitNext(outcome.runId) : {}),
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('boot_services', {
    description:
      "Apply the feature's envset and boot its services, then HOLD them — no Playwright tests, no heal loop. Use this to bring an app up so you (or the user) can exercise it manually. The run stays active until torn down with `abort_run`, which stops the services and reverts the envset. Same-repo collisions and resource limits behave exactly like start_run (returns repo_collision_requires_choice / queued).",
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      env: z.string().optional().describe("Envset name. Defaults to the feature's first declared env."),
      isolation: z.enum(['worktree', 'queue']).optional().describe('Only needed after this returns repo_collision_requires_choice: "worktree" boots in a per-run git worktree (concurrent); "queue" waits until the conflicting run finishes.'),
    },
  }, async ({ feature, env, isolation }) => {
    try {
      const outcome = await deps.startRun(feature, env, undefined, isolation, 'boot')
      if (outcome.kind === 'collision') {
        return asJsonResult({
          type: 'repo_collision_requires_choice',
          conflictingRunId: outcome.conflictingRunId,
          conflictingFeature: outcome.conflictingFeature,
          repoPaths: outcome.repoPaths,
          options: outcome.options,
          message: outcome.message,
          nextSteps: ['ask_user_worktree_or_queue'],
        })
      }
      if (outcome.kind === 'queued') {
        return asJsonResult({
          runId: outcome.runId,
          queued: true,
          queueReason: outcome.reason,
          nextSteps: ['boot starts automatically when capacity frees; stop it with abort_run when done'],
        })
      }
      return asJsonResult({
        runId: outcome.runId,
        booted: true,
        nextSteps: ['services are booting and will be held — exercise them, then call abort_run (confirm:true) to stop services + revert the envset. A service that fails its readiness probe is marked failed (status "timeout") but the session stays held; boot does not self-abort on a health-check failure'],
      })
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
      'Hard-abort an active run. Requires `confirm: true` because this kills Playwright + services and cannot be undone. Do not abort just to re-run: for an active healing run use `signal_run`, and to retry a failed/aborted run pass its `run_ref` to `start_run` (rerun, remaining-test mode). Abort is for killing a run you no longer want.',
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
      client_kind: clientKindInput,
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
      if (result.reason === 'client-kind-not-allowed') {
        return errorResult(
          `client-kind-not-allowed: heal claiming is restricted to Claude/Codex Desktop (this client is ${result.clientKind}). The run can still be run/verified; drive heal from Desktop or the web UI.`,
        )
      }
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
    description: 'Refresh the external heal session liveness. Sessions auto-disconnect after 10 minutes without any MCP traffic; any signal_run / get_heal_context call also refreshes liveness, so you usually do not need to call this explicitly during normal healing.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string(),
      client_kind: clientKindInput.describe('Which kind of client is heartbeating. Defaults to the MCP client type when known.'),
      status: HEAL_STATUS.default('connected'),
    },
  }, async ({ runId, session_id, client_kind, status }) => {
    ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    const result = deps.broker.heartbeat(runId, session_id, status)
    if (!result.ok) return errorResult(`heartbeat rejected: ${result.reason}`)
    return asJsonResult({ ok: true, session: result.session })
  })

  registerTool('wait_for_heal_task', {
    description:
      'Wait until a claimed external run needs code fixes or reaches a terminal result. Use after start_run/claim_heal and again after signal_run. This blocks for a short bounded window and heartbeats for you. If the run is still active when the window elapses it returns type:"still_waiting" (NOT terminal) — immediately call wait_for_heal_task again with the same runId + session_id to keep waiting. Loop on still_waiting until you get needs_heal / passed / failed. Never poll get_run_snapshot or get_run to wait.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string().describe('External heal session id that owns this run.'),
      client_kind: clientKindInput.describe('Which kind of client is waiting. Defaults to the MCP client type when known.'),
      timeout_ms: z.number().int().positive().max(WAIT_FOR_HEAL_TASK_MAX_TIMEOUT_MS)
        .default(WAIT_FOR_HEAL_TASK_DEFAULT_TIMEOUT_MS)
        .describe('Per-call block budget in ms (default 90s). A single call blocks at most ~2 minutes regardless; larger values are clamped, then you get still_waiting to loop on. This is not the overall heal budget — that is unbounded across re-calls.'),
    },
  }, async ({ runId, session_id, client_kind, timeout_ms }) => {
    const result = await waitForHealTask(deps, runId, session_id, client_kind, timeout_ms)
    return result.ok ? asJsonResult(result.value) : errorResult(result.error)
  })

  registerTool('signal_run', {
    description:
      'Write a heal-cycle signal. The orchestrator picks it up via its existing poll loop and writes the diagnosis journal from this signal plus runner-observed git diff. Use `rerun` for test-only fixes (no service restart) and `restart` when services need to be restarted.',
    inputSchema: {
      runId: z.string(),
      kind: SIGNAL_KIND,
      session_id: z.string().optional().describe('Required when the run holds an external claim; must match the claim holder.'),
      client_kind: clientKindInput.describe('Which kind of client is sending the signal. Defaults to the MCP client type when known.'),
      hypothesis: z.string().optional().describe('Required for restart/rerun. Concise diagnosis of what was wrong.'),
      fixDescription: z.string().optional().describe('Required for restart/rerun. Concise summary of what the fix changed.'),
    },
  }, async ({ runId, kind, session_id, client_kind, hypothesis, fixDescription }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (!isActiveRunStatus(detail.manifest.status)) {
      return errorResult(`run not active (status=${detail.manifest.status})`)
    }
    if ((kind === 'restart' || kind === 'rerun') && (!hasText(hypothesis) || !hasText(fixDescription))) {
      return errorResult('restart/rerun signal requires hypothesis and fixDescription')
    }
    if (session_id) ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    const ownership = deps.broker.assertOwnership(runId, session_id)
    if (!ownership.ok && ownership.reason === 'session-mismatch') {
      return errorResult(`session-mismatch: run is held by ${ownership.currentSession?.sessionId}`)
    }
    if (session_id) deps.broker.touch(runId, session_id)
    const body = kind === 'restart' || kind === 'rerun'
      ? { hypothesis: hypothesis!.trim(), fixDescription: fixDescription!.trim() }
      : {}
    let signal: ReturnType<typeof writeHealSignal>
    try {
      signal = writeHealSignal({ logsDir: deps.store.logsDir, runId, kind, body })
    } catch (err) {
      return errorResult(`could not write signal: ${(err as Error).message}`)
    }
    deps.broker.bumpCycle(runId)
    return asJsonResult({ accepted: true, kind, path: signal.path, runId, ...healWaitNext(runId) })
  })

  registerTool('handoff_heal', {
    description:
      'Hand off heal duty from this external session to a local heal mode (auto/claude/codex/manual). For active runs only manual is supported (the orchestrator cannot hot-swap to a local agent); for failed/aborted runs auto/claude/codex restart the heal with a fresh agent.',
    inputSchema: {
      runId: z.string(),
      to: z.enum(['auto', 'claude', 'codex', 'manual']),
      session_id: z.string().optional().describe('External heal session id. Required when the run holds an external claim and the caller is not the broker holder.'),
      guidance: z.string().optional().describe('Optional context passed to the restarted local heal agent. Ignored for to=manual.'),
      confirm: z.literal(true).describe('Must be true. Guards against accidental handoffs.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ runId, to, session_id, guidance }) => {
    if (!deps.handoffHeal) return errorResult('handoffHeal dependency is not configured')
    try {
      const result = await deps.handoffHeal(runId, to, session_id, guidance)
      if (result.statusCode >= 200 && result.statusCode < 300) {
        return asJsonResult(result.body)
      }
      const body = result.body
      const message = body && typeof body === 'object' && 'reason' in body
        ? `${(body as { reason: string }).reason}${'message' in body ? `: ${(body as { message: string }).message}` : ''}`
        : typeof body === 'string' ? body : `handoff failed (${result.statusCode})`
      return errorResult(message)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })
}

// ─── result helpers ─────────────────────────────────────────────────────

// Emitted in start_run / signal_run results so result-driven external clients
// (which may not carry the Canary Lab skill) block on wait_for_heal_task
// instead of inventing a get_run_snapshot poll loop. Mirrors the create_feature
// nextSteps convention.
function healWaitNext(runId: string): { nextSteps: string[]; next: string } {
  return {
    nextSteps: ['wait_for_heal_task'],
    next: `Call wait_for_heal_task with runId "${runId}" and the same session_id to wait for the result — it blocks for a short window and heartbeats for you. If it returns type:"still_waiting", call it again (not terminal). Do not poll get_run_snapshot or get_run in a loop to wait.`,
  }
}

const BOOT_SESSION_MESSAGE =
  'Boot-only session: services are up and held. No tests run and there is no heal task. A service that fails its readiness probe is marked failed (status "timeout") but the session stays held — boot does not self-abort on a health-check failure. Stop with abort_run (confirm:true) when done.'

// A boot run (started via boot_services) holds its services up with no Playwright
// tests and no heal loop. Following or waiting on one must not claim heal or block
// on wait_for_heal_task — surface a boot_session result so skill-less clients stop
// here too instead of dead-waiting until timeout.
function isActiveBootRun(detail: RunDetail | null | undefined): boolean {
  return (
    !!detail &&
    (detail.manifest.executionType ?? 'run') === 'boot' &&
    isActiveRunStatus(detail.manifest.status)
  )
}

// Emitted when a single wait_for_heal_task block elapses while the run is still
// active. NOT terminal — the agent must re-call wait_for_heal_task (same runId +
// session_id) to keep waiting. The cursor is informational (phase:cycles:status);
// re-calling is stateless and safe because classifyWaitForHealTask reads durable
// run state, so any transition during the gap is caught on the next immediate check.
function stillWaitingValue(
  runId: string,
  detail: RunDetail | null,
): Extract<WaitForHealTaskValue, { type: 'still_waiting' }> {
  const status = detail?.manifest.status ?? null
  const phase = detail?.manifest.lifecycle?.phase ?? 'unknown'
  const cycles = detail?.manifest.healCycles ?? 0
  return {
    type: 'still_waiting',
    runId,
    status,
    lifecycle: detail?.manifest.lifecycle ?? null,
    cursor: `${phase}:${cycles}:${status ?? 'unknown'}`,
    nextSteps: ['wait_for_heal_task'],
    next: `Run "${runId}" is still active (no heal task yet). This is NOT terminal — call wait_for_heal_task again with the same runId + session_id to keep waiting. Do not poll get_run_snapshot or get_run.`,
  }
}

function bootSessionValue(detail: RunDetail): Extract<WaitForHealTaskValue, { type: 'boot_session' }> {
  return {
    type: 'boot_session',
    runId: detail.manifest.runId,
    executionType: 'boot',
    status: detail.manifest.status,
    claimed: false,
    lifecycle: detail.manifest.lifecycle ?? null,
    message: BOOT_SESSION_MESSAGE,
    nextSteps: ['boot session — services are up and held; a service that failed its readiness probe shows status "timeout" but the session stays held (boot does not self-abort on health failure); exercise the live ones, then abort_run (confirm:true) when done'],
  }
}

type ClaimResult =
  | { accepted: true; session: unknown }
  | { accepted: false; reason: string; currentSession?: unknown }

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
  if (result.accepted) return { accepted: true, session: result.session }
  return result.reason === 'already-claimed'
    ? { accepted: false, reason: result.reason, currentSession: result.currentSession }
    : { accepted: false, reason: result.reason }
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

function statusForExternalStage(stage: ExternalDraftStage): DraftRecord['status'] {
  if (stage === 'ready') return 'spec-ready'
  if (stage === 'applied') return 'accepted'
  if (stage === 'error') return 'error'
  return 'generating'
}

function externalDraftView(record: DraftRecord): Record<string, unknown> {
  return {
    draftId: record.draftId,
    feature: record.featureName,
    featureName: record.featureName,
    source: record.source ?? 'internal',
    externalStage: record.externalStage,
    status: record.status,
    clientKind: record.externalClientKind,
    sessionId: record.externalSessionId,
    conversationName: record.externalConversationName,
    externalSessionUrl: record.externalSessionUrl,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
  }
}

function externalDraftAuthoringNextSteps(feature: string): string[] {
  return [
    'Tell the user you are authoring tests now and they can wait in the external client.',
    `Author or edit Playwright specs under features/${feature}/e2e.`,
    'Call update_external_draft_stage as progress changes.',
    'Call apply_external_draft when the files are ready to validate and record.',
  ]
}

function newDraftId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function newEvaluationTaskId(): string {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export'
}

function externalEvaluationReportSchema(detail: RunDetail): Record<string, unknown> {
  const packet = buildTestReviewPacket(detail)
  const rewrite = deterministicEvaluationRewrite(packet)
  return {
    output: 'evaluation.html',
    textSlots: evaluationTextSlots(rewrite),
    rewrite,
    requiredBehavior: [
      'Submit structured wording only; Canary Lab renders the final evaluation.html.',
      'If the run failed or was aborted, preserve that status in the report instead of blocking the export.',
      'Submit textSlots[] or rewrite through submit_external_evaluation_export.',
    ],
  }
}

function isToolErrorPayload(value: unknown): value is { error: string; statusCode?: number } {
  return !!value &&
    typeof value === 'object' &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'string'
}

type WaitForHealTaskValue =
  | { type: 'needs_heal'; runId: string; cycle: number; context: ExternalHealContext }
  | { type: 'passed'; runId: string; summary: RunDetail['summary'] | null; counts: NormalizedRunCounts }
  | { type: 'failed'; runId: string; status: string; summary: RunDetail['summary'] | null; counts: NormalizedRunCounts }
  | {
      type: 'still_waiting'
      runId: string
      status: string | null
      lifecycle: RunDetail['manifest']['lifecycle'] | null
      cursor: string
      nextSteps: string[]
      next: string
    }
  | {
      type: 'boot_session'
      runId: string
      executionType: 'boot'
      status: string
      claimed: false
      lifecycle: RunDetail['manifest']['lifecycle'] | null
      message: string
      nextSteps: string[]
    }

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

  if (isActiveBootRun(detail)) return { ok: true, value: bootSessionValue(detail) }

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
    const latest = deps.store.get(runId)
    if (!latest) return { ok: false, error: `run not found: ${runId}` }
    const context = buildExternalHealContext({
      detail: latest,
      logsDir: deps.store.logsDir,
      projectRoot: deps.projectRoot,
    })
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
  clientKind: ExternalHealClientKind,
  timeoutMs: number,
): Promise<WaitForHealTaskResult> {
  // A boot-only session never produces a heal task — return immediately instead
  // of claiming heal and blocking until timeout.
  const bootDetail = deps.store.get(runId)
  if (bootDetail && isActiveBootRun(bootDetail)) return { ok: true, value: bootSessionValue(bootDetail) }
  ensureExternalClaimForMcpCall(deps, runId, sessionId, clientKind)
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
      ensureExternalClaimForMcpCall(deps, runId, sessionId, clientKind)
      deps.broker.heartbeat(runId, sessionId, 'waiting')
    }
    deps.store.onEvent(onEvent)
    // Clamp the actual block to the window cap regardless of the requested
    // timeout_ms — bounds the request lifetime so it can't outlive a client's
    // JSON-RPC request timeout. On elapse we return `still_waiting`, not a
    // terminal `timeout`: the run is still going, the agent just re-calls.
    const windowMs = Math.min(Math.max(timeoutMs, 1), WAIT_FOR_HEAL_TASK_WINDOW_MS)
    const timeout = setTimeout(() => {
      const detail = deps.store.get(runId)
      finish({ ok: true, value: stillWaitingValue(runId, detail ?? null) })
    }, windowMs)
    const heartbeat = setInterval(beat, 5_000)
    if (typeof timeout.unref === 'function') timeout.unref()
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    beat()
    check()
  })
}

function ensureExternalClaimForMcpCall(
  deps: CanaryLabMcpDeps,
  runId: string,
  sessionId: string,
  clientKind: ExternalHealClientKind,
): void {
  const detail = deps.store.get(runId)
  if (!detail || detail.manifest.healMode !== 'external' || isTerminalRunStatus(detail.manifest.status)) {
    return
  }

  const existing = deps.broker.getSession(runId)
  if (!existing) {
    deps.broker.claim(runId, { sessionId, clientKind })
    return
  }

  if (existing.sessionId !== sessionId) return
  if (existing.clientKind === 'other' && clientKind !== 'other') {
    deps.broker.claim(runId, { sessionId, clientKind })
    return
  }
  deps.broker.touch(runId, sessionId)
}

function asJsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
