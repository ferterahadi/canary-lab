import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../src/features/runs/logic/run-store'
import type { RunDetail, RunStoreEvent } from '../src/features/runs/logic/run-store'
import type { ExternalHealBroker } from '../src/features/runs/logic/heal/external-heal-broker'
import type { ClientKind } from '../../../shared/run-mode'
import {
  buildExternalFailureDetail,
  buildExternalHealContext,
  buildExternalRunSnapshotSlim,
  normalizeRunCounts,
  slimRepeatHealContext,
  writeHealSignal,
  type ExternalHealContext,
  type NormalizedRunCounts,
} from '../src/features/runs/logic/heal/external-heal-surface'
import { loadFeatures } from '../src/features/config/logic/feature-loader'
import type { DirtySpecStore } from '../src/features/runs/logic/dirty-specs/store'
import { isHealClaimAllowed } from '../src/features/runs/logic/heal/heal-claim-policy'
import { computePortPreflight } from '../src/features/runs/logic/runtime/port-preflight'
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
} from '../src/features/config/logic/feature-authoring'
import {
  FeatureNotFoundError,
  clearPrdSummary,
  computeFeatureCoverage,
  listFeatureDocs,
} from '../src/features/coverage/logic/coverage/service'
import { CoverageJobRunStore } from '../src/features/coverage/logic/coverage/jobs/store'
import { CoverageJobConflictError } from '../src/features/coverage/logic/coverage/jobs/runner'
import {
  startExternalCoverage,
  submitExternalCoverage,
  startExternalSummary,
  submitExternalSummary,
} from '../src/features/coverage/logic/coverage/jobs/external'
import type { ParsedRequirement } from '../src/features/coverage/logic/coverage/prd-summary'
import type { ProposedMapping, SummaryState } from '../../../shared/coverage/types'
import {
  createDraft,
  paths as draftPaths,
  readDraft,
  writeDraft,
  type DraftRecord,
  type ExternalDraftStage,
} from '../src/features/wizard/logic/draft-store'
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
} from '../src/features/evaluation/logic/evaluation-export-store'
import { buildEvaluationExportArchive } from '../src/features/evaluation/logic/evaluation-export-archive'
import {
  applyEvaluationTextSlotRewrite,
  buildTestReviewPacket,
  deterministicEvaluationRewrite,
  evaluationTextSlots,
  normalizeEvaluationRewrite,
  type EvaluationRewrite,
} from '../src/features/evaluation/logic/test-review-export'
import {
  isActiveRunStatus,
  isTerminalRunStatus,
  deriveRunActionAvailability,
} from '../../../shared/run-state'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../src/shared/workspace-events'
import { encodeToonTable } from '../src/shared/toon'
import type {
  PortifyManifest,
  StartExternalPortifyInput,
  StartExternalPortifyResult,
} from '../src/features/portify/logic/runtime/types'
import { overlayExists as portifyOverlayExists } from '../src/features/portify/logic/runtime/overlay'

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

// One mapping the offloaded client produces for submit_external_coverage —
// matches the internal annotate output shape (coverage-annotate.schema.json).
const coverageMappingInput = z.object({
  testName: z.string().describe('Exact test name as given in the start context.'),
  requirements: z.array(z.string()).describe('Requirement id(s) this test verifies (e.g. ["R1"]). Unknown ids are dropped.'),
  pathTypes: z.array(z.enum(['happy', 'sad', 'edge'])).optional(),
  variants: z.array(z.string()).optional().describe('Variant value(s) this test exercises (e.g. ["email"]), from the feature\'s variant dimension. Values outside it are dropped. Omit for a variant-agnostic test.'),
  file: z.string().optional().describe('Relative spec path; omit and Canary resolves it by test name.'),
  rationale: z.string().optional(),
  confidence: z.number().optional(),
})

// One requirement an offloaded client proposes for an external PRD summary —
// mirrors prompts/prd-summary.schema.json (the shape the returned prompt asks
// for). Canary reconciles ids against the prior summary; never trust the agent's
// echoed id to renumber the spine.
const summaryRequirementInput = z.object({
  id: z.string().optional().describe('Echo a prior requirement id to PRESERVE it; omit for a new requirement.'),
  kind: z.enum(['functional', 'non-functional']).optional(),
  title: z.string().describe('Short "it should …" title.'),
  text: z.string().describe('The requirement statement.'),
  happyPath: z.string().optional(),
  unhappyPath: z.string().optional(),
  pathTypes: z.array(z.enum(['happy', 'sad', 'edge'])).describe('At least one of happy/sad/edge.'),
  variants: z.array(z.string()).optional().describe('Variant value(s) this requirement must hold across (≥2 of the feature\'s variantDimension values, e.g. ["email","whatsapp"]). Omit for a single-value / variant-agnostic requirement.'),
  variantsNA: z.array(z.object({ variant: z.string(), reason: z.string() })).optional().describe('Variants from `variants` with NO testable surface (e.g. {variant:"line",reason:"no broadcast endpoint"}). Excluded from coverage + shown as N/A. Only when you confirmed the surface is absent — not merely untested.'),
  strictnessLadder: z.array(z.object({
    tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    description: z.string(),
  })).optional(),
})

// The feature-level variant dimension (D1) an offloaded client may declare on
// submit_external_summary — mirrors prompts/prd-summary.schema.json.
const variantDimensionInput = z.object({
  name: z.string().describe('Lower-case single-token dimension name (e.g. "channel").'),
  values: z.array(z.string()).describe('Closed set of values a requirement may span (≥2, e.g. ["email","whatsapp","call","line"]).'),
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
      clientKind: ClientKind
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
      clientKind: ClientKind
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
   *  the save/cancel calls throw with a `statusCode` the tools surface. The
   *  agent-spawning start/revise are GUI-only (REST) — the MCP surface is
   *  external-producer only (the calling client does the edits itself). */
  /** External producer: set up the worktree, park at `editing`, and hand the
   *  external client the edit paths + the task prompt. No local agent is spawned —
   *  the client (running in the user's own Claude/Codex) edits the worktree in place. */
  startExternalPortify?: (input: StartExternalPortifyInput) => Promise<StartExternalPortifyResult>
  /** External producer: verify the client's in-place edits (double-boot) and park
   *  at ready-to-save (pass) or back at editing (fail). */
  submitExternalPortify?: (workflowId: string) => Promise<PortifyManifest>
  getPortify?: (workflowId: string) => PortifyManifest | null
  savePortify?: (workflowId: string) => Promise<PortifyManifest>
  cancelPortify?: (workflowId: string) => Promise<PortifyManifest>
  /** Un-portify a saved feature: revert its config (snapshot or legacy strip) +
   *  delete the overlay. Mirrors DELETE /api/features/:name/portify-overlay. */
  removePortification?: (feature: string) => { name: string; portified: boolean; reverted: boolean }
  workspaceEvents?: WorkspaceEventPublisher
  /** Test-file integrity store. When present, terminal/needs_heal run results
   *  carry a `dirtyTests` warning the agent relays verbatim. Read-only here —
   *  the MCP surface never approves or gates on it (awareness, not enforcement). */
  dirtySpecStore?: DirtySpecStore
  /** First Flight (`canary-lab fly` pipeline) driven over MCP. Reuses the
   *  flights REST routes via app.inject — same store + conductor as UI/CLI, so
   *  a flight started here shows live in the web UI and vice versa. */
  flightsRequest?: (opts: {
    method: 'GET' | 'POST'
    url: string
    payload?: unknown
  }) => Promise<{ statusCode: number; body: unknown }>
}

const CLIENT_KIND = z.enum(['claude', 'codex', 'claude-pty', 'codex-pty', 'other'])
const SIGNAL_KIND = z.enum(['rerun', 'restart', 'heal'])
const HEAL_STATUS = z.enum(['connected', 'waiting', 'healing', 'running-tests', 'paused', 'disconnected'])
const EXTERNAL_DRAFT_STAGE = z.enum(['scaffolding', 'authoring-tests', 'validating', 'ready', 'applied', 'error'])
const CLAIM_SUPPRESSED_MESSAGE =
  'Heal claiming is blocked for runner-spawned agents (the benchmark/portify PTY sessions Canary Lab launches itself), so this run was started without a heal claim. It still runs — drive heal from an interactive Claude/Codex client or the web UI.'
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

export const CANARY_LAB_MCP_PROFILES = ['repair', 'verify', 'author', 'portify', 'lifecycle', 'full'] as const
export type CanaryLabMcpProfile = typeof CANARY_LAB_MCP_PROFILES[number]

// The default profile when a client connects without an explicit one (bare
// `canary-lab mcp`, the registered Desktop/CLI invocation, a profile-less
// /mcp request). `lifecycle` is the everyday end-to-end surface (repair +
// author + verify + export) MINUS portify — the specialized, infrequent
// port-injection workflow. Portify clients opt in with `--profile portify`
// (or `full`), keeping the common surface leaner in tools + instructions.
export const DEFAULT_CANARY_LAB_MCP_PROFILE: CanaryLabMcpProfile = 'lifecycle'

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
  | 'clear_prd_summary'
  | 'start_external_summary'
  | 'submit_external_summary'
  | 'start_external_coverage'
  | 'submit_external_coverage'
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
  | 'start_flight'
  | 'get_flight'
  | 'respond_flight_checkpoint'
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
  | 'start_external_portify'
  | 'submit_external_portify'
  | 'get_portify'
  | 'save_portify'
  | 'cancel_portify'
  | 'remove_portification'
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
  'clear_prd_summary',
  'start_external_summary',
  'submit_external_summary',
  'start_external_coverage',
  'submit_external_coverage',
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
  'start_flight',
  'get_flight',
  'respond_flight_checkpoint',
] as const satisfies readonly CanaryLabMcpToolName[]

// Portify is a specialized, infrequent operation (make a feature's ports
// injectable so it can boot concurrently). It lives in its own profile so the
// everyday authoring/lifecycle surface stays lean; clients that need it connect
// with profile=portify (or full).
const PORTIFY_TOOLS = [
  'list_features',
  'list_runs',
  'start_external_portify',
  'submit_external_portify',
  'get_portify',
  'save_portify',
  'cancel_portify',
  'remove_portification',
  'list_portify_status',
] as const satisfies readonly CanaryLabMcpToolName[]

// Tools that exist only in the `full`/`lifecycle` profiles — everything else is
// composed from the per-workflow profiles above.
const FULL_ONLY_TOOLS = [
  'get_run_actions',
  'claim_heal',
  'release_heal',
] as const satisfies readonly CanaryLabMcpToolName[]

// `lifecycle` is the end-to-end authoring → run → heal → verify → export surface
// MINUS portify — the everyday one-session profile. `full` is `lifecycle` plus
// portify. Both are deduplicated unions, so adding a tool to any workflow array
// surfaces it automatically — no second edit, no drift, no duplicate entries.
const LIFECYCLE_TOOLS: readonly CanaryLabMcpToolName[] = Array.from(
  new Set<CanaryLabMcpToolName>([
    ...REPAIR_TOOLS,
    ...VERIFY_TOOLS,
    ...AUTHOR_TOOLS,
    ...FULL_ONLY_TOOLS,
  ]),
)

const FULL_TOOLS: readonly CanaryLabMcpToolName[] = Array.from(
  new Set<CanaryLabMcpToolName>([
    ...LIFECYCLE_TOOLS,
    ...PORTIFY_TOOLS,
  ]),
)

const TOOLS_BY_PROFILE: Record<CanaryLabMcpProfile, readonly CanaryLabMcpToolName[]> = {
  repair: REPAIR_TOOLS,
  verify: VERIFY_TOOLS,
  author: AUTHOR_TOOLS,
  portify: PORTIFY_TOOLS,
  lifecycle: LIFECYCLE_TOOLS,
  full: FULL_TOOLS,
}

export function isCanaryLabMcpProfile(value: string | undefined): value is CanaryLabMcpProfile {
  return !!value && (CANARY_LAB_MCP_PROFILES as readonly string[]).includes(value)
}

export function normalizeCanaryLabMcpProfile(value: string | undefined): CanaryLabMcpProfile | null {
  if (!value) return DEFAULT_CANARY_LAB_MCP_PROFILE
  return isCanaryLabMcpProfile(value) ? value : null
}

export function toolsForCanaryLabMcpProfile(profile: CanaryLabMcpProfile): readonly CanaryLabMcpToolName[] {
  return TOOLS_BY_PROFILE[profile]
}

export interface CanaryLabMcpToolOptions {
  profile?: CanaryLabMcpProfile
  defaultClientKind?: ClientKind
}

/** Recovery steering for a BLOCKED coverage ledger. The no-source-doc case is the only
 *  one that needs the user: grounded coverage must come from a real PRD/spec, so ASK for
 *  it — never invent one or silently pull an external file. */
function coverageBlockedNext(feature: string, summary: SummaryState, sourceDocCount: number): string {
  if (summary === 'generating') {
    return `A summary/coverage job is already running for "${feature}" (single-flight). Wait for it to finish, then get_feature_coverage("${feature}").`
  }
  if (summary === 'stale') {
    return `PRD summary for "${feature}" is stale (see state.drift.changedDocs). YOU refresh it: start_external_summary("${feature}"), read the source docs in the returned prompt, submit_external_summary (ids preserved), then start_external_coverage("${feature}") + submit_external_coverage to remap.`
  }
  // summary 'absent'
  if (sourceDocCount === 0) {
    return `No source doc on file for "${feature}", so there is nothing to ground coverage on. ASK THE USER to attach or paste the PRD/spec in the chat (do NOT invent one or pull an external file). Once they provide it, write_feature_doc("${feature}", "<name>.md", <content>) then start_external_summary("${feature}") — read the docs yourself and submit_external_summary.`
  }
  return `Source docs exist for "${feature}" but no PRD summary yet. YOU author it: start_external_summary("${feature}"), read the source docs in the returned prompt, submit_external_summary, then start_external_coverage("${feature}") + submit_external_coverage to map tests → requirements.`
}

export function registerCanaryLabTools(
  server: McpServer,
  deps: CanaryLabMcpDeps,
  opts: CanaryLabMcpToolOptions = {},
): void {
  const profile = opts.profile ?? DEFAULT_CANARY_LAB_MCP_PROFILE
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
    description: 'List existing Canary Lab features when you need to choose or inspect one. Do not call this before random/new feature creation; call create_feature directly with a unique name and retry on collision. Returned as a TOON table `[N]{name,description,envs,repos}:`. To keep one flat row per feature, the list-valued columns are packed: `envs` is `|`-joined env names; `repos` is `|`-joined repo entries, each `name@localPath@branch` (branch empty if none). Split on `|` then `@` to unpack.',
    inputSchema: {},
  }, async () => {
    const features = loadFeatures(deps.featuresDir).map((f) => ({
      name: f.name,
      description: f.description ?? '',
      // Pack the list-valued fields into delimited scalars so the array reaches
      // the TOON tabular form (one flat row per feature) instead of the verbose
      // list form. Lossless for paths/branches that don't contain `@` or `|`.
      envs: (f.envs ?? []).join('|'),
      repos: (f.repos ?? [])
        .map((r) => [r.name, r.localPath, r.branch ?? ''].join('@'))
        .join('|'),
    }))
    return asToonResult(features)
  })

  registerTool('list_runs', {
    description: 'List Canary Lab runs, newest first (default 20 — raise `limit` for more history). Optionally filter by feature. Each row is already slim (id, feature, status, timestamps); fetch one run\'s detail with get_run. Returned as a TOON table: a `[N]{col,...}:` header line followed by one comma-separated row per run (quoted cells are JSON-escaped strings).',
    inputSchema: {
      feature: z.string().optional().describe('Feature name. Omit to list across all features.'),
      limit: z.number().int().positive().max(200).default(20).describe('Max runs to return, newest first. Default 20.'),
    },
  }, async ({ feature, limit }) => {
    return asToonResult(deps.store.list(feature ? { feature } : {}).slice(0, limit))
  })

  registerTool('get_run', {
    description: 'Fetch one run\'s core detail: manifest + summary + artifact base URL. The bulky raw arrays (lifecycleEvents, playwrightArtifacts, playbackEvents) are OMITTED by default to protect context — pass includeRaw:true to inline them when you need them. Never poll this to wait for a result; block on wait_for_heal_task.',
    inputSchema: {
      runId: z.string(),
      includeRaw: z.boolean().default(false).describe('Inline the full lifecycleEvents[] + playwrightArtifacts[] + playbackEvents[]. Off by default (they can be large); call again with includeRaw:true when you need the raw timeline/artifacts.'),
    },
  }, async ({ runId, includeRaw }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (includeRaw) return asJsonResult(detail)
    const { lifecycleEvents: _lifecycleEvents, playwrightArtifacts: _playwrightArtifacts, playbackEvents: _playbackEvents, ...core } = detail
    return asJsonResult({
      ...core,
      artifactsBase: `/api/runs/${encodeURIComponent(runId)}/artifacts/`,
      raw: { omitted: ['lifecycleEvents', 'playwrightArtifacts', 'playbackEvents'], hint: 'call get_run with includeRaw:true to inline them' },
    })
  })

  registerTool('get_run_snapshot', {
    description: 'Verbose external-heal run snapshot: summary, full counts, failed tests, artifact base, heal prompt map, and the heal index + journal as on-disk PATHS (Read them for the full markdown — never inlined, so a long heal loop can\'t bloat the response). For verbose debugging only; never poll it to wait — block on wait_for_heal_task.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    return asJsonResult(buildExternalRunSnapshotSlim({
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
      const created = createVerificationConfig(feature, { name, targetUrls, playwrightEnvsetId })
      // Refresh an open Verify dialog on other clients without a reopen.
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'verification-config-changed', feature: featureId })
      return asJsonResult(created)
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
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'verification-config-changed', feature: featureId })
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
      'Write a prose doc (session, plan, notes) into a feature\'s docs/ dir. Create-or-replace (re-writing the same relPath overwrites); markdown only (.md/.markdown). Use for "add this plan/distillation to feature <name>".',
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
    // Docs feed the PRD summary; refresh the Docs rail + coverage headline live.
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature })
    return asJsonResult({ written: true, path: result.writtenPath, relativePath: result.relativePath })
  })

  registerTool('delete_feature_doc', {
    description:
      'Delete a SOURCE doc from a feature\'s docs/ dir. Refuses generated artifacts (_prd-* / _coverage-* files canary manages). After removing docs, regenerate the PRD summary so coverage reflects the change.',
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
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature })
    return asJsonResult({ deleted: true, relativePath: result.relativePath })
  })

  registerTool('get_feature_coverage', {
    description:
      'Get the Semantic Coverage Ledger: PRD requirements → mapped tests → gap type (untested / path-incomplete / covered) with a coverage % (covered ÷ total declared paths) and mapped % (requirements with ≥1 test), per-test strength (strong/solid/basic/shallow from assertion tiers), and docs-drift. DECOUPLED from test runs — measures test→requirement+path mapping, never whether a run passed. Use it to find untested/path-incomplete requirements and shallow tests. When the ledger is BLOCKED (state.coverage:"blocked") it carries a `next:` field with the recovery step; if it says no source doc exists, ASK THE USER to attach/paste the PRD in chat (never invent or pull one) before generating.',
    inputSchema: { feature: z.string().describe('Existing feature name (from list_features).') },
  }, async ({ feature }) => {
    try {
      const ledger = computeFeatureCoverage({
        featuresDir: deps.featuresDir,
        logsDir: deps.store.logsDir,
        feature,
      })
      // Blocked ledger is silent on recovery — every sibling coverage tool returns a
      // `next:`. Attach one so the agent acts instead of hedging. The no-source-doc case
      // is the only one that needs a HUMAN step: ask for the doc, don't invent/pull one.
      if (ledger.state?.coverage === 'blocked') {
        const sourceDocCount = listFeatureDocs(deps.featuresDir, feature).sourceDocCount
        return asJsonResult({ ...ledger, next: coverageBlockedNext(feature, ledger.state.summary, sourceDocCount) })
      }
      return asJsonResult(ledger)
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

  registerTool('clear_prd_summary', {
    description:
      'Reset a feature\'s coverage to a blank slate: remove the generated PRD summary + its coverage sidecars (pending mappings, run-state) and strip the @req-*/@path-*/@variant-* tags from the specs (other tags kept; specs revert to pre-coverage shape). Source docs are untouched; the feature returns to the "no summary" state. Returns { removed, untagged } (untagged = specs whose tags were cleared).',
    inputSchema: { feature: z.string().describe('Existing feature name (from list_features).') },
  }, async ({ feature }) => {
    try {
      const result = clearPrdSummary({ featuresDir: deps.featuresDir, feature })
      // Coverage badge + spec tags both change; refresh the ledger view and the
      // tests panel (specs were un-tagged) on every client without a reload.
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature })
      return asJsonResult(result)
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      throw err
    }
  })

  registerTool('start_external_summary', {
    description:
      'Start a PRD-summary pass YOU drive — no local agent. Returns the source docs (paths to read), the previous requirement ids to PRESERVE, and a `prompt`: read each source doc, extract testable requirements, then call submit_external_summary with the requirements[]. Canary reconciles ids against the prior summary (the stable spine) and writes docs/_prd-summary.{json,md} — never re-derives the requirements. Single-flight (rejected if a summary/coverage job is running). No source doc yet → status:"needs-docs" (ASK THE USER for the PRD; do not invent one). This is the FIRST step of coverage — follow it with start_external_coverage. Offload to a background task or fan out across docs when the PRD is large.',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      session_id: z.string().describe('Stable id for your conversation — reuse it across calls.'),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ feature, session_id, client_kind, conversation_name, external_session_url }) => {
    try {
      const res = startExternalSummary(
        {
          featuresDir: deps.featuresDir,
          logsDir: deps.store.logsDir,
          feature,
          sessionId: session_id,
          clientKind: client_kind,
          ...(conversation_name ? { conversationName: conversation_name } : {}),
          ...(external_session_url ? { sessionUrl: external_session_url } : {}),
        },
        { store: new CoverageJobRunStore(deps.store.logsDir), workspaceEvents: deps.workspaceEvents },
      )
      if (res.kind === 'needs-docs') {
        return asJsonResult({
          status: 'needs-docs',
          feature,
          next: `No source doc on file for "${feature}". ASK THE USER to attach or paste the PRD/spec (do NOT invent one or pull an external file), then write_feature_doc("${feature}", "<name>.md", <content>) and call start_external_summary again.`,
        })
      }
      return asJsonResult({
        jobId: res.manifest.jobId,
        status: res.manifest.status,
        canaryLabBehavior: 'tracking-only',
        statusMeaning: 'You read the source docs and propose requirements using context.prompt; Canary spawns no agent — submit_external_summary reconciles ids and writes the summary.',
        context: res.context,
        nextSteps: ['submit_external_summary'],
        next: `Follow context.prompt: read each doc in context.docs, extract requirements (reuse a context.previousRequirementIds id to preserve it), then call submit_external_summary with jobId "${res.manifest.jobId}" and requirements[].`,
      })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      if (err instanceof CoverageJobConflictError) return errorResult(`${err.message} (existing job ${err.existingJobId})`)
      throw err
    }
  })

  registerTool('submit_external_summary', {
    description:
      'Submit your extracted requirements for an external PRD-summary job. Canary reconciles ids against the prior summary (preserving surviving ids; new ones get fresh ids; dropped ones marked deprecated), writes docs/_prd-summary.{json,md}, marks the job done, and recomputes the ledger. Then call start_external_coverage to map tests → requirements.',
    inputSchema: {
      jobId: z.string().describe('Job id returned by start_external_summary.'),
      requirements: z.array(summaryRequirementInput).describe('The testable requirements extracted from the source docs.'),
      variantDimension: variantDimensionInput.optional().describe('The feature\'s single cross-cutting dimension (channel/tenant/region/...), if it has one. Omit when no dimension applies.'),
    },
  }, async ({ jobId, requirements, variantDimension }) => {
    try {
      const { manifest, result } = submitExternalSummary(
        {
          featuresDir: deps.featuresDir,
          jobId,
          requirements: requirements as ParsedRequirement[],
          ...(variantDimension ? { variantDimension } : {}),
        },
        { store: new CoverageJobRunStore(deps.store.logsDir), workspaceEvents: deps.workspaceEvents },
      )
      return asJsonResult({
        jobId: manifest.jobId,
        feature: manifest.feature,
        status: manifest.status,
        requirementCount: result.summary.requirements.length,
        written: result.written,
        nextSteps: ['start_external_coverage'],
        next: `Wrote the PRD summary (${result.summary.requirements.length} requirement(s)). Call start_external_coverage("${manifest.feature}") to map tests → requirements.`,
      })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('start_external_coverage', {
    description:
      'Start a coverage mapping pass YOU drive — no local agent. Returns the active requirements, the feature\'s tests (with file paths to read), and a `prompt`: read each test, decide its requirement id(s), then call submit_external_coverage with the mappings. Canary writes the @req-* tags via its canonical tag-writer and recomputes the ledger (never re-derives the mapping). Single-flight (rejected if a coverage job is running). No PRD summary yet → status:"needs-summary" (call start_external_summary first). Offload to a background task or fan out across tests when there are many.',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      session_id: z.string().describe('Stable id for your conversation — reuse it across calls.'),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ feature, session_id, client_kind, conversation_name, external_session_url }) => {
    try {
      const res = startExternalCoverage(
        {
          featuresDir: deps.featuresDir,
          logsDir: deps.store.logsDir,
          feature,
          sessionId: session_id,
          clientKind: client_kind,
          ...(conversation_name ? { conversationName: conversation_name } : {}),
          ...(external_session_url ? { sessionUrl: external_session_url } : {}),
        },
        { store: new CoverageJobRunStore(deps.store.logsDir), workspaceEvents: deps.workspaceEvents },
      )
      if (res.kind === 'needs-summary') {
        return asJsonResult({
          status: 'needs-summary',
          feature,
          next: `No PRD summary for "${feature}". Call start_external_summary first (read the docs, submit_external_summary), then start_external_coverage again.`,
        })
      }
      return asJsonResult({
        jobId: res.manifest.jobId,
        status: res.manifest.status,
        canaryLabBehavior: 'tracking-only',
        statusMeaning: 'You do the mapping using context.prompt; Canary spawns no agent — submit_external_coverage writes the tags + recomputes the ledger.',
        context: res.context,
        nextSteps: ['submit_external_coverage'],
        next: `Follow context.prompt: read each test\'s file, decide its requirement id(s), then call submit_external_coverage with jobId "${res.manifest.jobId}" and mappings[].`,
      })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      if (err instanceof CoverageJobConflictError) return errorResult(`${err.message} (existing job ${err.existingJobId})`)
      throw err
    }
  })

  registerTool('submit_external_coverage', {
    description:
      'Submit your test→requirement mappings for an external coverage job. Canary writes each @req-* tag via its canonical tag-writer (idempotent/additive — never rewrites a test body), marks the job done, and recomputes the ledger; unknown ids/test names are dropped. Then call get_feature_coverage.',
    inputSchema: {
      jobId: z.string().describe('Job id returned by start_external_coverage.'),
      mappings: z.array(coverageMappingInput).describe('One entry per test you could map. Omit tests you cannot confidently map.'),
    },
  }, async ({ jobId, mappings }) => {
    try {
      const { manifest, result } = submitExternalCoverage(
        {
          featuresDir: deps.featuresDir,
          logsDir: deps.store.logsDir,
          jobId,
          mappings: mappings as ProposedMapping[],
        },
        { store: new CoverageJobRunStore(deps.store.logsDir), workspaceEvents: deps.workspaceEvents },
      )
      return asJsonResult({
        jobId: manifest.jobId,
        feature: manifest.feature,
        status: manifest.status,
        applied: result.applied.length,
        coveragePct: result.ledger.coveragePct,
        nextSteps: ['get_feature_coverage'],
        next: `Wrote ${result.applied.length} covers tag(s). Call get_feature_coverage("${manifest.feature}") for the updated ledger.`,
      })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_feature_envset_summary', {
    description: 'List a feature envset layout, slot targets, redacted key previews, and the feature\'s declared repos (name/localPath/branch — pass repo name to get_feature_repo_status / checkout_feature_repo_branch). Secret values are never returned.',
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
    if (isToolErrorPayload(result)) return errorResult(result.error)
    // Branch moved; refresh the feature list + Repos tab git-status row live.
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
    return asJsonResult(result)
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
      reportSchema: externalEvaluationReportSchema(detail),
      runSnapshotVia: `get_run_snapshot("${runId}")`,
      nextSteps: ['call get_run_snapshot(runId) if you need the run summary/failures while authoring', 'author structured evaluation wording', 'submit_external_evaluation_export'],
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
        const expected = packet.tests.length
        const received = Array.isArray((rewrite as EvaluationRewrite | undefined)?.cases)
          ? (rewrite as EvaluationRewrite).cases.length
          : 0
        return errorResult(
          `rewrite.cases must contain exactly ${expected} ${expected === 1 ? 'entry' : 'entries'} — one per evaluated test, in the same order as reportSchema.rewrite.cases (got ${received}). Do NOT merge, dedupe, or drop skipped or duplicate run entries; every run entry needs its own case. Each case requires title, whatWasChecked, whyItMatters, and confidence (all strings).`,
        )
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
        // Compact, chat-ready digest of the rendered evaluation so the agent can
        // relay the result in the conversation instead of only pointing at the
        // UI. Kept small (titles + verdicts, not full flow steps); the full
        // rendered evaluation.html ships via download_evaluation_export.
        evaluation: {
          featureTitle: normalizedRewrite.featureTitle ?? next!.feature,
          summary: normalizedRewrite.summary,
          cases: normalizedRewrite.cases.map((c) => ({ title: c.title, confidence: c.confidence })),
        },
        nextSteps: [
          'Present this evaluation to the user in chat — the featureTitle, the summary, and the per-case title + confidence verdicts. Do not just say it is available in the UI.',
          'download_evaluation_export returns the full rendered evaluation.html archive if the user wants the file.',
        ],
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('list_evaluation_exports', {
    description: 'List persisted evaluation export tasks. Returned as a TOON table: a `[N]{col,...}:` header line followed by one comma-separated row per task (quoted cells are JSON-escaped strings).',
    inputSchema: { runId: z.string().optional() },
  }, async ({ runId }) => {
    const tasks = listEvaluationExportTasks(deps.store.logsDir, runId ? { runId } : {})
    return asToonResult(tasks.map(evaluationExportTaskView))
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
      producer: 'external',
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
    if ((current.producer ?? 'internal') !== 'external') return errorResult('draft is not external-owned')
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
    if ((current.producer ?? 'internal') !== 'external') return errorResult('draft is not external-owned')
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

  // ── First Flight (`canary-lab fly` — conducted onboarding pipeline) ──────
  const FLIGHT_DATA_INLINE_BUDGET = 8 * 1024 // ≈2K tokens — past this, review in the web UI
  const flightView = (raw: unknown): Record<string, unknown> => {
    const m = raw as {
      flightId: string; feature: string; status: string; currentStage: string | null
      runVerdict?: string; error?: string; links?: unknown
      stages?: Array<{ key: string; status: string; error?: string; skipReason?: string; checkpoint?: unknown }>
    }
    const waiting = (m.stages ?? []).find((s) => s.status === 'waiting-for-approval')
    let checkpoint = waiting?.checkpoint as { data?: unknown } | undefined
    if (checkpoint?.data !== undefined && JSON.stringify(checkpoint.data).length > FLIGHT_DATA_INLINE_BUDGET) {
      checkpoint = { ...checkpoint, data: { omitted: true, reason: 'payload over the inline budget — review it in the web UI flight view, then respond here' } }
    }
    return {
      flightId: m.flightId,
      feature: m.feature,
      status: m.status,
      currentStage: m.currentStage,
      ...(m.runVerdict ? { runVerdict: m.runVerdict } : {}),
      ...(m.error ? { error: m.error } : {}),
      ...(m.links ? { links: m.links } : {}),
      stages: (m.stages ?? []).map((s) => ({
        key: s.key,
        status: s.status,
        ...(s.error ? { error: s.error } : {}),
        ...(s.skipReason ? { skipReason: s.skipReason } : {}),
      })),
      ...(waiting && checkpoint ? { checkpoint: { stage: waiting.key, ...checkpoint } } : {}),
    }
  }
  const flightNext = (view: Record<string, unknown>): string => {
    if (view.status === 'waiting-for-approval') {
      const cp = view.checkpoint as { stage?: string; kind?: string; options?: string[] } | undefined
      const base = `Flight is parked on the ${cp?.kind ?? 'checkpoint'} checkpoint — call respond_flight_checkpoint(flightId, choice: one of ${JSON.stringify(cp?.options ?? [])}).`
      if (cp?.kind === 'prd-source') {
        return `${base} BEFORE responding: if this conversation carries requirements, distill them with write_feature_doc("${String(view.feature)}", "conversation-prd.md", <markdown>) — dropped docs win the source hierarchy; then respond with any choice (e.g. "retry").`
      }
      return base
    }
    if (view.status === 'running') return 'Flight is running — re-call get_flight to follow it; it parks on checkpoints and settles to done/paused/failed.'
    if (view.status === 'paused') return 'Flight is paused (a stage failed or the server restarted). Fix the cause if needed, then start_flight on the same repos resumes it from the failed stage.'
    if (view.status === 'done') return 'Flight is done — links.evaluationZip is the deliverable archive.'
    return ''
  }
  const flightsUnavailable = () => errorResult('flightsRequest dependency is not configured')

  registerTool('start_flight', {
    description: 'Start (or resume) a First Flight: one background pipeline that takes bare product repo(s) to a green, covered, healed run ending in an evaluation export (similarity → scout → scaffold → env → docs → PRD → specs↔coverage → portify → run → heal → export). The server conducts every stage and computes every verdict; you approve checkpoints via respond_flight_checkpoint and can feed conversation-distilled docs via write_feature_doc. A paused flight for the same repos is resumed instead of duplicated; an ACTIVE one returns its id to follow.',
    inputSchema: {
      repoPaths: z.array(z.string()).min(1).describe('Absolute path(s) of the product repo(s); several paths become ONE feature spanning them.'),
      description: z.string().describe('What to test, e.g. "checkout flow".'),
      feature: z.string().optional().describe('Feature name; defaults to a slug of the first repo basename.'),
      env: z.string().optional().describe('Envset name (default "local").'),
      coverage_target: z.number().min(0).max(100).optional().describe('Coverage % the specs↔coverage loop must reach (default 100).'),
      base: z.string().optional().describe('Base branch for diff-inferred requirements (auto-detected when omitted).'),
      yolo: z.boolean().optional().describe('Skip every checkpoint except missing env secrets.'),
      fresh: z.boolean().optional().describe('Do not resume a paused flight — start over.'),
    },
  }, async ({ repoPaths, description, feature, env, coverage_target, base, yolo, fresh }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    const list = await deps.flightsRequest({ method: 'GET', url: '/api/flights' })
    const flights = ((list.body as { flights?: Array<{ flightId: string; status: string; repoPaths?: string[] }> }).flights ?? [])
    const targets = new Set(repoPaths.map((p) => path.resolve(p)))
    const latest = flights.find((f) => (f.repoPaths ?? []).some((p) => targets.has(path.resolve(p))))
    if (latest && (latest.status === 'running' || latest.status === 'waiting-for-approval')) {
      const current = await deps.flightsRequest({ method: 'GET', url: `/api/flights/${encodeURIComponent(latest.flightId)}` })
      const view = flightView(current.body)
      return asJsonResult({ ...view, note: 'a flight is already active for these repos — following it', next: flightNext(view) })
    }
    if (latest && latest.status === 'paused' && !fresh) {
      const resumed = await deps.flightsRequest({ method: 'POST', url: `/api/flights/${encodeURIComponent(latest.flightId)}/resume` })
      if (resumed.statusCode !== 200) return errorResult(`resume failed (${resumed.statusCode}): ${String((resumed.body as { error?: string }).error ?? '')}`)
      const view = flightView(resumed.body)
      return asJsonResult({ ...view, note: 'resumed the paused flight from its first open stage', next: flightNext(view) })
    }
    const started = await deps.flightsRequest({
      method: 'POST',
      url: '/api/flights',
      payload: {
        repoPaths,
        description,
        feature: feature ?? (path.basename(repoPaths[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'first-flight'),
        ...(env ? { env } : {}),
        ...(coverage_target !== undefined ? { coverageTarget: coverage_target } : {}),
        ...(base ? { base } : {}),
        ...(yolo ? { yolo } : {}),
      },
    })
    if (started.statusCode !== 201) {
      return errorResult(`start_flight failed (${started.statusCode}): ${String((started.body as { error?: string }).error ?? '')}`)
    }
    const view = flightView(started.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  registerTool('get_flight', {
    description: 'Fetch one flight (stage rail + open checkpoint) by id, or list all flights when flightId is omitted. Poll this to follow a running flight; it parks on checkpoints (respond via respond_flight_checkpoint) and settles to done/paused/failed.',
    inputSchema: {
      flightId: z.string().optional().describe('Omit to list all flights (slim rows).'),
    },
  }, async ({ flightId }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    if (!flightId) {
      const list = await deps.flightsRequest({ method: 'GET', url: '/api/flights' })
      const rows = ((list.body as { flights?: Array<Record<string, unknown>> }).flights ?? []).map((f) => ({
        flightId: f.flightId, feature: f.feature, status: f.status, currentStage: f.currentStage, repoPaths: f.repoPaths,
      }))
      return asJsonResult({ flights: rows })
    }
    const resp = await deps.flightsRequest({ method: 'GET', url: `/api/flights/${encodeURIComponent(flightId)}` })
    if (resp.statusCode !== 200) return errorResult(`flight not found: ${flightId}`)
    const view = flightView(resp.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  registerTool('respond_flight_checkpoint', {
    description: 'Release a flight parked waiting-for-approval: pass the choice (from the checkpoint\'s options), user-supplied env values for missing-env, or an edited configSource via data for config-approval. For the prd-source checkpoint, first write conversation-distilled requirements with write_feature_doc — dropped docs win the source hierarchy.',
    inputSchema: {
      flightId: z.string(),
      choice: z.string().optional().describe('One of the checkpoint\'s options.'),
      values: z.record(z.string(), z.string()).optional().describe('missing-env only: KEY→value map, written to the missing env file then captured.'),
      data: z.unknown().optional().describe('config-approval only: { configSource } with the hand-edited draft.'),
    },
  }, async ({ flightId, choice, values, data }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    const resp = await deps.flightsRequest({
      method: 'POST',
      url: `/api/flights/${encodeURIComponent(flightId)}/respond`,
      payload: { response: { ...(choice ? { choice } : {}), ...(values ? { values } : {}), ...(data !== undefined ? { data } : {}) } },
    })
    if (resp.statusCode !== 200) {
      return errorResult(`respond failed (${resp.statusCode}): ${String((resp.body as { error?: string }).error ?? '')}`)
    }
    const view = flightView(resp.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  // ── Port-ification (make a feature's apps use injectable ports) ──────────
  registerTool('start_external_portify', {
    description: "Start a port-ification workflow YOU drive — no local agent. Canary sets up a scratch worktree per repo and returns the edit paths + task. Edit the listeners to read injected ports IN PLACE, declare the `ports` slots in the feature config, then submit_external_portify to verify (concurrent double-boot); save_portify captures the result as the feature's overlay. Async — returns a workflowId + targets; one workflow PER FEATURE (different features can port-ify concurrently up to a resource cap, so you can fan out a subagent per feature; at capacity start_external_portify returns a 429 — wait for one to finish, or save/cancel it).",
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      session_id: z.string().describe('Stable id for your conversation — reuse it across calls.'),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ feature, session_id, client_kind, conversation_name, external_session_url }) => {
    if (!deps.startExternalPortify) return errorResult('startExternalPortify dependency is not configured')
    try {
      const result = await deps.startExternalPortify({
        feature,
        clientKind: client_kind,
        sessionId: session_id,
        ...(conversation_name ? { conversationName: conversation_name } : {}),
        ...(external_session_url ? { sessionUrl: external_session_url } : {}),
      })
      return asJsonResult({
        ...result,
        status: 'editing',
        canaryLabBehavior: 'tracking-only',
        statusMeaning: 'You edit the scratch worktrees in place; Canary Lab is not running a local agent — it verifies + saves.',
        nextSteps: ['submit_external_portify'],
        next: `Edit each target's source (in its worktree path) so the listener reads an injected port, declare the matching \`ports\` slots in ${result.configPath}, then call submit_external_portify with workflowId "${result.workflowId}". Poll get_portify; save_portify once status is "ready-to-save".`,
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('submit_external_portify', {
    description: 'Submit your in-place edits for an external port-ification workflow: Canary Lab captures the worktree diff and boots the stack twice concurrently on different ports to verify. Async — the workflow goes to verifying, then ready-to-save (passed) or back to editing (failed — read verification.failureDetail, fix the worktree, and submit again). Poll get_portify. Only valid while the workflow is in "editing".',
    inputSchema: { workflowId: z.string() },
  }, async ({ workflowId }) => {
    if (!deps.submitExternalPortify) return errorResult('submitExternalPortify dependency is not configured')
    try {
      const manifest = await deps.submitExternalPortify(workflowId)
      return asJsonResult({
        ...manifest,
        nextSteps: ['get_portify'],
        next: `Poll get_portify with workflowId "${workflowId}": on "ready-to-save" call save_portify; if it returns to "editing", read verification.failureDetail, fix the worktree, and submit_external_portify again. cancel_portify discards the workflow.`,
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_portify', {
    description: 'Read a port-ification workflow: status (planning/editing/verifying/ready-to-save/saved/failed/aborted), attempt count, and the double-boot verification result. The full unified diff is OMITTED by default (it can be a large multi-file patch) — `diffStats` summarizes it; pass includeDiff:true to inline the patch text.',
    inputSchema: {
      workflowId: z.string(),
      includeDiff: z.boolean().default(false).describe('Inline the full unified diff. Off by default (the patch can be large); diffStats gives files/additions/deletions. Call again with includeDiff:true for the patch text.'),
    },
  }, async ({ workflowId, includeDiff }) => {
    if (!deps.getPortify) return errorResult('getPortify dependency is not configured')
    const manifest = deps.getPortify(workflowId)
    if (!manifest) return errorResult(`port-ification workflow not found: ${workflowId}`)
    if (includeDiff) return asJsonResult(manifest)
    const { diff, ...rest } = manifest
    return asJsonResult({
      ...rest,
      ...(diff ? { diffStats: summarizeUnifiedDiff(diff), diffOmitted: true, diffHint: 'call get_portify with includeDiff:true to inline the patch' } : {}),
    })
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
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return asJsonResult({
        ...manifest,
        next: `Overlay saved to features/${manifest.feature}/portify/. The feature now boots with injectable ports on every run — concurrent runs and benchmark arms will not clash — without ever modifying the product repo.`,
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

  registerTool('remove_portification', {
    description: "Un-portify a SAVED feature: reverts its feature config (the declared `ports` slots + the `${port.x}` health-check rewrites) and deletes the port overlay, so it boots on its hardcoded ports again and is no longer portified. Always auto-cleans — overlays carry a pre-Portify config snapshot, so the revert is exact. Legacy overlays (no snapshot) best-effort strip the slots; their health-check tokens need a re-run of Portify to regenerate. Requires confirm: true.",
    inputSchema: {
      feature: z.string(),
      confirm: z.literal(true).describe('Must be true. Guards against discarding a saved overlay + reverting config.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ feature }) => {
    if (!deps.removePortification) return errorResult('removePortification dependency is not configured')
    try {
      const result = deps.removePortification(feature)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return asJsonResult(result)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_heal_context', {
    description: 'Compact failure handoff packet an external heal agent needs first: current failures, artifact URLs, heal-index, journal, repo branches, lifecycle, and heal prompt map. Use get_run_snapshot for verbose raw summary/debugging fields.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
      client_kind: clientKindInput,
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
      'One failing test\'s detail: error, location, resolved pointer dirs (trace-extract, playwright-mcp), curated trace summary, and the full error text — both inlined in full (never truncated; a large file over the inline budget is swapped for a `traceSummaryPath`/`errorTextPath` to Read in chunks). Use `failureId` from a failedTests[] entry (get_heal_context / wait_for_heal_task). Built for fan-out: hand each failureId to its own read-only sub-agent to investigate AND draft a proposed patch in parallel; the claim owner then applies the patches serially and signals once.',
    inputSchema: {
      runId: z.string(),
      failureId: z.string().describe('The failureId (== failed test name) from a failedTests[] entry.'),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
      client_kind: clientKindInput,
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
      'Smart entrypoint for runs. If a matching run is healing, returns it and blocks fresh/different starts until cancel_heal stops it. If runId/run_ref targets a failed/aborted run and no heal is active, restarts it in remaining-test mode (failed → skipped → pending/not-run). Otherwise starts a new run. To retry a failed/aborted run prefer this rerun path (pass run_ref) over abort_run + a fresh start — a fresh start re-runs the whole suite, only worth it when prior passes are invalidated (e.g. a global data/state change). The rerun path already re-runs skipped + pending tests (failed → skipped → pending/not-run), so it is complete — do NOT force_new just to avoid "skipped" tests; force_new on a portified feature spins a brand-new per-run worktree and resets the heal journal to Iteration 1, losing the prior cycles. After code changes call signal_run (hypothesis + fixDescription), then wait_for_heal_task on the same run.',
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      env: z.string().optional().describe('Envset name. Defaults to the feature\'s first declared env.'),
      runId: z.string().optional().describe('Exact run id to resume/restart. A different run currently healing blocks this.'),
      run_ref: z.string().optional().describe('Exact run id or unique suffix (e.g. "7cvh") to resume/restart. A different run currently healing blocks this.'),
      claim_heal: z.boolean().default(true).describe('Claim this run\'s heal duty for the current MCP session.'),
      session_id: z.string().describe('Stable id for this MCP/agent session. Reuse across calls in one conversation to enable reconnects.'),
      client_kind: clientKindInput,
      conversation_name: z.string().optional().describe('Human label shown in the Canary Lab UI (e.g. "fix checkout").'),
      guidance: z.string().optional().describe('Optional user guidance when restarting a failed/aborted run by runId or run_ref.'),
      force_new: z.boolean().default(false).describe('Start a fresh concurrent run even if a matching run is healing (it continues independently). A same-repo collision still asks you to choose isolation.'),
      isolation: z.enum(['worktree', 'queue']).optional().describe('Only needed after start_run returns repo_collision_requires_choice: "worktree" isolates this run in a per-run git worktree and starts it now (concurrent); "queue" waits until the conflicting run finishes.'),
    },
  }, async ({ feature, env, runId, run_ref, claim_heal, session_id, client_kind, conversation_name, guidance, force_new, isolation }) => {
    try {
      const requestedRef = runId ?? run_ref
      // Heal-claim policy (see heal-claim-policy.ts): claiming is open to every
      // human-driven interactive client — claude/codex (Desktop or CLI) and even
      // undetected 'other'. The ONLY kinds blocked are runner-spawned PTY agents
      // (claude-pty/codex-pty), which would otherwise claim their own run. A
      // blocked client may still start/verify the run, but must not own its heal
      // loop — so we down-shift claim_heal to false and tell the caller, instead
      // of grabbing heal duty behind their back.
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
          ...(claimAllowed ? healWaitNext() : {}),
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
            ...(claimAllowed ? healWaitNext() : {}),
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
          ...(claimAllowed ? healWaitNext() : {}),
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
          ...(claimAllowed ? healWaitNext() : {}),
        })
      }
      return asJsonResult({
        runId: outcome.runId,
        reused: false,
        claimed: claimAllowed,
        ...suppressionFields,
        ...(claimAllowed ? healWaitNext() : {}),
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
    description: 'Refresh external heal session liveness. Sessions auto-disconnect after 10 min without MCP traffic; signal_run / get_heal_context also refresh it, so you rarely need to call this explicitly.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string(),
      client_kind: clientKindInput,
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
      'Wait until a claimed run needs code fixes or reaches a terminal result. Use after start_run/claim_heal and again after signal_run. Blocks for a short bounded window and heartbeats for you. If still active when the window elapses it returns type:"still_waiting" (NOT terminal) — immediately call wait_for_heal_task again with the same runId + session_id. Loop on still_waiting until needs_heal / passed / failed. Never poll get_run_snapshot or get_run to wait. A needs_heal task may be a service that failed to boot (no tests ran): context.failedTests is empty and context.bootFailure points at the service log — fix the service/app code, then signal_run kind:"restart".',
    inputSchema: {
      runId: z.string(),
      session_id: z.string().describe('External heal session id that owns this run.'),
      client_kind: clientKindInput,
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
      client_kind: clientKindInput,
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
    return asJsonResult({ accepted: true, kind, path: signal.path, runId, ...healWaitNext() })
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
// nextSteps convention. Machine-readable nextSteps only — the prose "how" lives
// once in REPAIR_INSTRUCTIONS (session init) and the wait_for_heal_task tool
// description, so re-emitting it on every start_run/signal_run was dead weight.
function healWaitNext(): { nextSteps: string[] } {
  return { nextSteps: ['wait_for_heal_task'] }
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
    // nextSteps is the machine-readable contract; the "not terminal, re-call"
    // prose lives in the wait_for_heal_task tool description, so we don't repay
    // it on every elapsed window (a long run loops still_waiting many times).
    nextSteps: ['wait_for_heal_task'],
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
    producer: record.producer ?? 'internal',
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
      `If you submit a rewrite, rewrite.cases must have EXACTLY ${rewrite.cases.length} ${rewrite.cases.length === 1 ? 'entry' : 'entries'}, in this same order — one per run entry. Do NOT merge, dedupe, or drop skipped/duplicate runs; edit the wording of the provided cases, never change their count or order. (Prefer textSlots[] to keep the count correct automatically.)`,
    ],
  }
}

function isToolErrorPayload(value: unknown): value is { error: string; statusCode?: number } {
  return !!value &&
    typeof value === 'object' &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'string'
}

// Test-file integrity warning, present only when a spec changed since the last
// green/run-start and wasn't approved/committed. The agent relays `message`
// verbatim; Canary never blocks or gates on it (awareness, not enforcement).
interface DirtyTestsWarning {
  dirty: true
  specs: string[]
  message: string
}

type WaitForHealTaskValue =
  | { type: 'needs_heal'; runId: string; cycle: number; context: ExternalHealContext; dirtyTests?: DirtyTestsWarning }
  | { type: 'passed'; runId: string; summary: RunDetail['summary'] | null; counts: NormalizedRunCounts; dirtyTests?: DirtyTestsWarning }
  | { type: 'failed'; runId: string; status: string; summary: RunDetail['summary'] | null; counts: NormalizedRunCounts; dirtyTests?: DirtyTestsWarning }
  | {
      type: 'still_waiting'
      runId: string
      status: string | null
      lifecycle: RunDetail['manifest']['lifecycle'] | null
      cursor: string
      nextSteps: string[]
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

// Read the feature's current dirty status from the integrity store. Returns a
// relay-ready warning (omitted when clean / store absent) so the agent surfaces
// "⚠️ Tests have been modified, please review." on a passing or failing run.
function dirtyTestsWarning(deps: CanaryLabMcpDeps, feature: string): DirtyTestsWarning | undefined {
  const rec = deps.dirtySpecStore?.get(feature)
  if (!rec || rec.status !== 'dirty') return undefined
  return { dirty: true, specs: rec.dirtySpecs.map((s) => s.file), message: rec.message }
}

export function classifyWaitForHealTask(
  deps: CanaryLabMcpDeps,
  runId: string,
  sessionId: string,
): WaitForHealTaskResult | null {
  const detail = deps.store.get(runId)
  if (!detail) return { ok: false, error: `run not found: ${runId}` }

  if (isActiveBootRun(detail)) return { ok: true, value: bootSessionValue(detail) }

  const status = detail.manifest.status
  const dirtyTests = dirtyTestsWarning(deps, detail.manifest.feature)
  if (status === 'passed') {
    return {
      ok: true,
      value: {
        type: 'passed',
        runId,
        summary: detail.summary ?? null,
        counts: normalizeRunCounts(detail.summary ?? null),
        ...(dirtyTests ? { dirtyTests } : {}),
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
        ...(dirtyTests ? { dirtyTests } : {}),
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
    const full = buildExternalHealContext({
      detail: latest,
      logsDir: deps.store.logsDir,
      projectRoot: deps.projectRoot,
    })
    // The procedure (nextSteps) and resource map (healPrompt) are static across
    // cycles — ship them on cycle 1 only; later cycles get the slim variant
    // (failure packet + breadcrumb). get_heal_context re-fetches the full map.
    const cycle = detail.manifest.lifecycle.activeCycle ?? detail.manifest.healCycles
    const context = cycle >= 2 ? slimRepeatHealContext(full) : full
    return {
      ok: true,
      value: {
        type: 'needs_heal',
        runId,
        cycle,
        context,
        ...(dirtyTests ? { dirtyTests } : {}),
      },
    }
  }

  return null
}

async function waitForHealTask(
  deps: CanaryLabMcpDeps,
  runId: string,
  sessionId: string,
  clientKind: ClientKind,
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
  clientKind: ClientKind,
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

// Cheap summary of a unified diff so get_portify can omit the (potentially large)
// patch text by default while still telling the agent how big the edit is. The
// full patch is one includeDiff:true call away.
function summarizeUnifiedDiff(diff: string): { files: number; additions: number; deletions: number } {
  let files = 0
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) files += 1
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { files, additions, deletions }
}

function asJsonResult(value: unknown): CallToolResult {
  // Compact (no indentation): the model parses JSON regardless, and the 2-space
  // pretty-print was pure whitespace tokens on every result across all tools.
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

// For list results: a TOON table of uniform rows costs ~half the tokens of the
// equivalent compact JSON (the field names are emitted once as a header instead
// of per row). encodeToonTable normalizes rows to a uniform scalar shape first
// and falls back to compact JSON when the data isn't tabular, so this is safe to
// point at any array-of-records result.
function asToonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: encodeToonTable(value) }] }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
