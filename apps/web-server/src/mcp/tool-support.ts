// Shared surface for the MCP tool groups: input schemas, profile arrays, the
// dependency interface, and the result/format helpers every group calls.
//
// Split out of tools.ts so the four domain groups in ./tool-groups/ can import
// it without importing tools.ts back — tools.ts imports the groups, so anything
// they share has to live below both of them.

import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../features/runs/logic/run-store'
import type { RunDetail, RunStoreEvent } from '../features/runs/logic/run-store'
import type { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import type { ClientKind } from '../../../../shared/run-mode'
import {
  buildExternalFailureDetail,
  buildExternalHealContext,
  buildExternalRunSnapshotSlim,
  normalizeRunCounts,
  slimRepeatHealContext,
  writeHealSignal,
  type ExternalHealContext,
  type NormalizedRunCounts,
} from '../features/runs/logic/heal/external-heal-surface'
import { loadFeatures } from '../features/config/logic/feature-loader'
import type { DirtySpecStore } from '../features/runs/logic/dirty-specs/store'
import { isHealClaimAllowed } from '../features/runs/logic/heal/heal-claim-policy'
import { computePortPreflight } from '../features/runs/logic/runtime/port-preflight'
import { flightStageRemedy } from '../features/flights/logic/stage-remedy'
import type { FlightManifest } from '../../../../shared/flights/types'
import {
  createVerificationConfig,
  getVerificationConfig,
  listVerificationConfigs,
  updateVerificationConfig,
  type ResolveVerificationInput,
} from '../features/coverage/logic/verification'
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
  linkFeatureDoc,
  type EnvFileSource,
} from '../features/config/logic/feature-authoring'
import {
  FeatureNotFoundError,
  clearPrdSummary,
  computeFeatureCoverage,
  listFeatureDocs,
} from '../features/coverage/logic/coverage/service'
import { deriveFeatureSlug } from '../../../../shared/flights/types'
import { CoverageJobRunStore } from '../features/coverage/logic/coverage/jobs/store'
import { CoverageJobConflictError } from '../features/coverage/logic/coverage/jobs/runner'
import {
  startExternalCoverage,
  submitExternalCoverage,
  startExternalSummary,
  submitExternalSummary,
} from '../features/coverage/logic/coverage/jobs/external'
import type { ParsedRequirement } from '../features/coverage/logic/coverage/prd-summary'
import type { ProposedMapping, SummaryState } from '../../../../shared/coverage/types'
import {
  createDraft,
  paths as draftPaths,
  readDraft,
  writeDraft,
  type DraftRecord,
  type ExternalDraftStage,
} from '../features/wizard/logic/draft-store'
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
} from '../features/evaluation/logic/evaluation-export-store'
import { buildEvaluationExportArchive } from '../features/evaluation/logic/evaluation-export-archive'
import {
  applyEvaluationTextSlotRewrite,
  buildTestReviewPacket,
  deterministicEvaluationRewrite,
  evaluationTextSlots,
  normalizeEvaluationRewrite,
  type EvaluationRewrite,
} from '../features/evaluation/logic/test-review-export'
import {
  isActiveRunStatus,
  isTerminalRunStatus,
  deriveRunActionAvailability,
} from '../../../../shared/run-state'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../shared/workspace-events'
import { encodeToonTable } from '../shared/toon'
import type {
  PortifyManifest,
  StartExternalPortifyInput,
  StartExternalPortifyResult,
} from '../features/portify/logic/runtime/types'
import { overlayExists as portifyOverlayExists } from '../features/portify/logic/runtime/overlay'

// Every Canary Lab MCP tool is a thin wrapper around an existing internal
// helper or REST handler. The translation pattern: validate input via zod,
// call the helper, format the result as a CallToolResult.
//
// Confirmation gates: destructive tools (abort_run, delete_run, etc.) require
// `confirm: true` literally in the input schema so a misbehaving model can't
// invoke them by accident.

export const evaluationTextSlotInput = z.object({
  id: z.string(),
  text: z.string(),
})

// One mapping the offloaded client produces for submit_external_coverage —
// matches the internal annotate output shape (coverage-annotate.schema.json).
export const coverageMappingInput = z.object({
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
export const summaryRequirementInput = z.object({
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
export const variantDimensionInput = z.object({
  name: z.string().describe('Lower-case single-token dimension name (e.g. "channel").'),
  values: z.array(z.string()).describe('Closed set of values a requirement may span (≥2, e.g. ["email","whatsapp","call","line"]).'),
})

export const evaluationRewriteInput = z.object({
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
  /** R76: deleting a feature deletes its flight history with it — guards
   *  (error while a flight is active) and removes the records. Absent →
   *  directory-only delete, the pre-R76 behavior. */
  removeFlightRecordsFor?: (feature: string) => { error?: string; removed: number }
  /** Flight (`canary-lab flight` pipeline) driven over MCP. Reuses the
   *  flights REST routes via app.inject — same store + conductor as UI/CLI, so
   *  a flight started here shows live in the web UI and vice versa. */
  flightsRequest?: (opts: {
    method: 'GET' | 'POST'
    url: string
    payload?: unknown
  }) => Promise<{ statusCode: number; body: unknown }>
}

export const CLIENT_KIND = z.enum(['claude', 'codex', 'claude-pty', 'codex-pty', 'other'])
export const SIGNAL_KIND = z.enum(['rerun', 'restart', 'heal'])
export const HEAL_STATUS = z.enum(['connected', 'waiting', 'healing', 'running-tests', 'paused', 'disconnected'])
export const EXTERNAL_DRAFT_STAGE = z.enum(['scaffolding', 'authoring-tests', 'validating', 'ready', 'applied', 'error'])
export const CLAIM_SUPPRESSED_MESSAGE =
  'Heal claiming is blocked for runner-spawned agents (the benchmark/portify PTY sessions Canary Lab launches itself), so this run was started without a heal claim. It still runs — drive heal from an interactive Claude/Codex client or the web UI.'
// `timeout_ms` is the per-call block budget — how long ONE wait_for_heal_task
// request may hold open. It is NOT the overall heal budget: when the window
// elapses with the run still active, the call returns `still_waiting` and the
// agent immediately re-calls. This keeps every request well under any client
// JSON-RPC request timeout (the cause of the -32001 the long-poll used to hit),
// while the logical wait stays unbounded across re-calls.
export const WAIT_FOR_HEAL_TASK_DEFAULT_TIMEOUT_MS = 90 * 1000
export const WAIT_FOR_HEAL_TASK_MAX_TIMEOUT_MS = 60 * 60 * 1000
// Hard cap on a single block regardless of the requested timeout_ms. Large
// requested values are clamped to this (not rejected) so older clients keep
// working — they just get a `still_waiting` to loop on sooner.
export const WAIT_FOR_HEAL_TASK_WINDOW_MS = 120 * 1000

export const CANARY_LAB_MCP_PROFILES = ['repair', 'verify', 'author', 'coverage', 'export', 'flight', 'portify', 'lifecycle', 'full'] as const
export type CanaryLabMcpProfile = typeof CANARY_LAB_MCP_PROFILES[number]

// The default profile when a client connects without an explicit one (bare
// `canary-lab mcp`, the registered Desktop/CLI invocation, a profile-less
// /mcp request). `lifecycle` is the everyday end-to-end surface (repair +
// verify + author + coverage + export + flight) MINUS portify — the
// specialized, infrequent port-injection workflow. Portify clients opt in
// with `--profile portify` (or `full`), keeping the common surface leaner in
// tools + instructions.
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

export const REPAIR_TOOLS = [
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

export const VERIFY_TOOLS = [
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

// Author = create/extend a feature, write specs, capture envsets, manage the
// feature's repos. Docs/PRD/coverage live in `coverage`, evaluation archives in
// `export`, and the conducted pipeline in `flight` — all four used to be one
// array; the split keeps each skill/client surface lean while `lifecycle`/`full`
// stay the same computed unions.
export const AUTHOR_TOOLS = [
  'list_features',
  'list_runs',
  'get_run',
  'get_run_snapshot',
  'create_feature',
  'get_feature_envset_summary',
  'capture_feature_env_files',
  'write_envset',
  'delete_feature',
  'get_feature_repo_status',
  'checkout_feature_repo_branch',
  'start_external_draft',
  'update_external_draft_stage',
  'apply_external_draft',
] as const satisfies readonly CanaryLabMcpToolName[]

// Coverage = feature docs → PRD summary → semantic coverage ledger (carved out
// of the old author array; the tools are unchanged).
export const COVERAGE_TOOLS = [
  'list_features',
  'write_feature_doc',
  'delete_feature_doc',
  'list_feature_docs',
  'clear_prd_summary',
  'start_external_summary',
  'submit_external_summary',
  'start_external_coverage',
  'submit_external_coverage',
  'get_feature_coverage',
] as const satisfies readonly CanaryLabMcpToolName[]

// Export = evaluation archives for a terminal run (carved out of the old
// author array). list_runs/get_run ride along to pick the run to export.
export const EXPORT_TOOLS = [
  'list_features',
  'list_runs',
  'get_run',
  'start_external_evaluation_export',
  'submit_external_evaluation_export',
  'list_evaluation_exports',
  'get_evaluation_export',
  'download_evaluation_export',
  'delete_evaluation_export',
] as const satisfies readonly CanaryLabMcpToolName[]

// Flight = the conducted end-to-end pipeline. write_feature_doc rides along so
// the client can distill conversation docs at the prd-source checkpoint.
export const FLIGHT_TOOLS = [
  'start_flight',
  'get_flight',
  'respond_flight_checkpoint',
  'write_feature_doc',
] as const satisfies readonly CanaryLabMcpToolName[]

// Portify is a specialized, infrequent operation (make a feature's ports
// injectable so it can boot concurrently). It lives in its own profile so the
// everyday authoring/lifecycle surface stays lean; clients that need it connect
// with profile=portify (or full).
export const PORTIFY_TOOLS = [
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
export const FULL_ONLY_TOOLS = [
  'get_run_actions',
  'claim_heal',
  'release_heal',
] as const satisfies readonly CanaryLabMcpToolName[]

// `lifecycle` is the end-to-end authoring → run → heal → verify → export surface
// MINUS portify — the everyday one-session profile. `full` is `lifecycle` plus
// portify. Both are deduplicated unions, so adding a tool to any workflow array
// surfaces it automatically — no second edit, no drift, no duplicate entries.
export const LIFECYCLE_TOOLS: readonly CanaryLabMcpToolName[] = Array.from(
  new Set<CanaryLabMcpToolName>([
    ...REPAIR_TOOLS,
    ...VERIFY_TOOLS,
    ...AUTHOR_TOOLS,
    ...COVERAGE_TOOLS,
    ...EXPORT_TOOLS,
    ...FLIGHT_TOOLS,
    ...FULL_ONLY_TOOLS,
  ]),
)

export const FULL_TOOLS: readonly CanaryLabMcpToolName[] = Array.from(
  new Set<CanaryLabMcpToolName>([
    ...LIFECYCLE_TOOLS,
    ...PORTIFY_TOOLS,
  ]),
)

export const TOOLS_BY_PROFILE: Record<CanaryLabMcpProfile, readonly CanaryLabMcpToolName[]> = {
  repair: REPAIR_TOOLS,
  verify: VERIFY_TOOLS,
  author: AUTHOR_TOOLS,
  coverage: COVERAGE_TOOLS,
  export: EXPORT_TOOLS,
  flight: FLIGHT_TOOLS,
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
export function coverageBlockedNext(feature: string, summary: SummaryState, sourceDocCount: number): string {
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


/**
 * What a tool group closes over. `registerTool` is the profile gate built in
 * registerCanaryLabTools: it drops any tool not in the active profile and throws
 * on a tool that belongs to no profile at all.
 */
export interface ToolGroupContext {
  registerTool: McpServer['registerTool']
  deps: CanaryLabMcpDeps
  // Derived, not restated: zod's ZodEnum generic shape is version-sensitive, so
  // spelling this type by hand breaks on a zod upgrade.
  clientKindInput: ReturnType<typeof CLIENT_KIND.default>
}


// ─── result helpers ─────────────────────────────────────────────────────

// Emitted in start_run / signal_run results so result-driven external clients
// (which may not carry the Canary Lab skill) block on wait_for_heal_task
// instead of inventing a get_run_snapshot poll loop. Mirrors the create_feature
// nextSteps convention. Machine-readable nextSteps only — the prose "how" lives
// once in REPAIR_INSTRUCTIONS (session init) and the wait_for_heal_task tool
// description, so re-emitting it on every start_run/signal_run was dead weight.
export function healWaitNext(): { nextSteps: string[] } {
  return { nextSteps: ['wait_for_heal_task'] }
}

export const BOOT_SESSION_MESSAGE =
  'Boot-only session: services are up and held. No tests run and there is no heal task. A service that fails its readiness probe is marked failed (status "timeout") but the session stays held — boot does not self-abort on a health-check failure. Stop with abort_run (confirm:true) when done.'

// A boot run (started via boot_services) holds its services up with no Playwright
// tests and no heal loop. Following or waiting on one must not claim heal or block
// on wait_for_heal_task — surface a boot_session result so skill-less clients stop
// here too instead of dead-waiting until timeout.
export function isActiveBootRun(detail: RunDetail | null | undefined): boolean {
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
export function stillWaitingValue(
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

export function bootSessionValue(detail: RunDetail): Extract<WaitForHealTaskValue, { type: 'boot_session' }> {
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

export type ClaimResult =
  | { accepted: true; session: unknown }
  | { accepted: false; reason: string; currentSession?: unknown }

export function claimRun(
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

export function findHealingRunForFeature(
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

export function activeRunPriority(detail: RunDetail): number {
  if (detail.manifest.lifecycle?.phase === 'waiting-for-signal') return 0
  if (detail.manifest.status === 'healing') return 1
  return 2
}

export type RunRefResolution =
  | { kind: 'resolved'; detail: RunDetail }
  | { kind: 'ambiguous'; candidates: RunDetail[] }
  | { kind: 'missing' }

export function resolveRunRef(
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

export function runCandidate(detail: RunDetail): Record<string, unknown> {
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

export function verificationResult(detail: RunDetail): Record<string, unknown> {
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

export function mcpVerificationStatus(status: string): string {
  if (status === 'aborted') return 'cancelled'
  return status
}

export function statusForExternalStage(stage: ExternalDraftStage): DraftRecord['status'] {
  if (stage === 'ready') return 'spec-ready'
  if (stage === 'applied') return 'accepted'
  if (stage === 'error') return 'error'
  return 'generating'
}

export function externalDraftView(record: DraftRecord): Record<string, unknown> {
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

export function externalDraftAuthoringNextSteps(feature: string): string[] {
  return [
    'Tell the user you are authoring tests now and they can wait in the external client.',
    `Author or edit Playwright specs under features/${feature}/e2e.`,
    'Call update_external_draft_stage as progress changes.',
    'Call apply_external_draft when the files are ready to validate and record.',
  ]
}

export function newDraftId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function newEvaluationTaskId(): string {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export'
}

export function externalEvaluationReportSchema(detail: RunDetail): Record<string, unknown> {
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

export function isToolErrorPayload(value: unknown): value is { error: string; statusCode?: number } {
  return !!value &&
    typeof value === 'object' &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'string'
}

// Test-file integrity warning, present only when a spec changed since the last
// green/run-start and wasn't approved/committed. The agent relays `message`
// verbatim; Canary never blocks or gates on it (awareness, not enforcement).
export interface DirtyTestsWarning {
  dirty: true
  specs: string[]
  message: string
}

export type WaitForHealTaskValue =
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

export type WaitForHealTaskResult =
  | { ok: true; value: WaitForHealTaskValue }
  | { ok: false; error: string }

// Read the feature's current dirty status from the integrity store. Returns a
// relay-ready warning (omitted when clean / store absent) so the agent surfaces
// "⚠️ Tests have been modified, please review." on a passing or failing run.
export function dirtyTestsWarning(deps: CanaryLabMcpDeps, feature: string): DirtyTestsWarning | undefined {
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

export async function waitForHealTask(
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

export function ensureExternalClaimForMcpCall(
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
export function summarizeUnifiedDiff(diff: string): { files: number; additions: number; deletions: number } {
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

export function asJsonResult(value: unknown): CallToolResult {
  // Compact (no indentation): the model parses JSON regardless, and the 2-space
  // pretty-print was pure whitespace tokens on every result across all tools.
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

// For list results: a TOON table of uniform rows costs ~half the tokens of the
// equivalent compact JSON (the field names are emitted once as a header instead
// of per row). encodeToonTable normalizes rows to a uniform scalar shape first
// and falls back to compact JSON when the data isn't tabular, so this is safe to
// point at any array-of-records result.
export function asToonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: encodeToonTable(value) }] }
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

export function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

