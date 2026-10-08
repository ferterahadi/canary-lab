import { unifiedDiffLines } from '../../../../shared/lib/unified-diff'
import { selectRunForFeature } from '../features/runs/logic/active-run-selection'
// Shared surface for the MCP tool groups: input schemas, profile arrays, the
// dependency interface, and the result/format helpers every group calls.
//
// Split out of tools.ts so the four domain groups in ./tool-groups/ can import
// it without importing tools.ts back — tools.ts imports the groups, so anything
// they share has to live below both of them.

import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { RunDetail } from '../../../../shared/run-detail'
import type { ClientKind } from '../../../../shared/run-mode'
import type { SummaryState } from '../../../../shared/coverage/types'
import type { DraftRecord, ExternalDraftStage } from '../../../../shared/draft-types'
import { isActiveRunStatus, isTerminalRunStatus } from '../../../../shared/run-state'
import { encodeToonTable } from '../shared/toon'
import type { McpClientFacts } from './client-surface'
import type { CanaryLabMcpDeps, GettingStartedBusyActive, McpStartRunOutcome } from './tool-schemas'
import type { FeatureAuthoringContext } from '../features/config/logic/feature-authoring'
import { errorMessage } from '../../../../shared/lib/error-message'

/** The feature-authoring context an MCP tool passes to a shared writer. Built
 *  in one place because it carries `workspaceEvents` — the writers announce
 *  their own writes (see FeatureAuthoringContext), and a tool that assembled
 *  the context by hand would silently write without notifying any client. */
export function authoringCtx(deps: CanaryLabMcpDeps): FeatureAuthoringContext {
  return {
    projectRoot: deps.projectRoot,
    featuresDir: deps.featuresDir,
    workspaceEvents: deps.workspaceEvents,
  }
}

export const CLIENT_KIND = z.enum(['claude', 'codex', 'claude-pty', 'codex-pty', 'other'])

export const SIGNAL_KIND = z.enum(['rerun', 'restart', 'heal'])

export const HEAL_STATUS = z.enum(['connected', 'waiting', 'healing', 'running-tests', 'paused', 'disconnected'])

export const EXTERNAL_DRAFT_STAGE = z.enum(['scaffolding', 'authoring-tests', 'validating', 'ready', 'applied', 'error'])

export const CLAIM_SUPPRESSED_MESSAGE =
  'Heal claiming is blocked for runner-spawned agents (the benchmark/portify PTY sessions Canary Lab launches itself), so this run was started without a heal claim. It still runs — drive heal from an interactive Claude/Codex client or the web UI.'

/** Recovery steering preserves grounded requirements: discover authorized
 * sources first, and elicit only the unresolved material. */
export function coverageBlockedNext(feature: string, summary: SummaryState, sourceDocCount: number): string {
  if (summary === 'generating') {
    return `A summary/coverage job is already running for "${feature}" (single-flight). Wait for it to finish, then get_feature_coverage("${feature}").`
  }
  if (summary === 'stale') {
    return `PRD summary for "${feature}" is stale (see state.drift.changedDocs). YOU refresh it: call start_external_summary with feature "${feature}" and a stable session_id, read the source docs in the returned prompt, submit_external_summary (ids preserved), then call start_external_coverage with the same session_id and submit_external_coverage to remap.`
  }
  // summary 'absent'
  if (sourceDocCount === 0) {
    return `No source doc on file for "${feature}". Call start_external_summary with feature "${feature}" and a stable session_id for document discovery. Search authorized repositories and user-provided references before asking; return document_resolution with source evidence or a missing/ambiguous/conflicting issue. Only unresolved material triggers MCP 2.0 elicitation. Never invent requirements or infer them from code without authorization. Only if elicitation is unavailable, ASK THE USER to attach or paste the PRD or resolve the specific source question, then write_feature_doc and retry.`
  }
  return `Source docs exist for "${feature}" but no PRD summary yet. YOU author it: call start_external_summary with feature "${feature}" and a stable session_id, read the source docs in the returned prompt, submit_external_summary, then call start_external_coverage with the same session_id and submit_external_coverage to map tests → requirements.`
}

/**
 * What a tool group closes over. `registerTool` is the profile gate built in
 * registerCanaryLabTools: it drops any tool not in the active profile and throws
 * on a tool that belongs to no profile at all.
 */
export interface ToolGroupContext {
  registerTool: McpServer['registerTool']
  deps: CanaryLabMcpDeps
  /** Who is connected on THIS session, read at call time rather than at
   *  registration: `clientInfo` only exists after the initialize handshake, which
   *  happens after the tools are registered. Lets a tool result adapt its advice
   *  (fan out vs read serially) to what the client can actually do. */
  clientFacts: () => McpClientFacts
  // Derived, not restated: zod's ZodEnum generic shape is version-sensitive, so
  // spelling this type by hand breaks on a zod upgrade.
  clientKindInput: ReturnType<typeof CLIENT_KIND.default>
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

export function findContinuingRunForFeature(
  deps: CanaryLabMcpDeps,
  feature: string,
  env: string | undefined,
): RunDetail | null {
  return selectRunForFeature(
    deps.store, feature, env,
    (entry) => isActiveRunStatus(entry.status),
    (detail) => detail.manifest.executionType !== 'boot',
  )
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
    'Tell the user you are authoring tests now and they can wait in the external agent session.',
    `Author or edit Playwright specs under features/${feature}/e2e.`,
    'Call update_external_draft_stage as progress changes.',
    'Call apply_external_draft when the files are ready to validate and record.',
  ]
}

export function newDraftId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function isToolErrorPayload(value: unknown): value is { error: string; statusCode?: number } {
  return !!value &&
    typeof value === 'object' &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'string'
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
  for (const { kind } of unifiedDiffLines(diff)) {
    if (kind === 'file') files += 1
    else if (kind === 'addition') additions += 1
    else if (kind === 'deletion') deletions += 1
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

type GettingStartedBusyResponse =
  | { active: GettingStartedBusyActive; message: string; variant?: 'default' | 'run' }
  | { active?: unknown; message?: string; variant: 'flight' }

/** Keep the existing tool-specific steering fields while sharing the rejection. */
export function gettingStartedBusyResult(busy: GettingStartedBusyResponse): CallToolResult {
  return asJsonResult({
    type: 'getting_started_busy',
    active: busy.active,
    message: busy.message,
    ...(busy.variant === 'flight'
      ? { next: 'Follow the active demo in its current owner; do not start another run or Flight.' }
      : { nextSteps: [busy.variant === 'run'
        ? 'follow the active demo in its current owner; do not start another run or flight'
        : 'follow the active demo in its current owner; do not start another Getting Started workflow'] }),
  })
}

export function repoCollisionResult(outcome: Extract<McpStartRunOutcome, { kind: 'collision' }>): CallToolResult {
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

/**
 * Render an unexpected throw as a tool error.
 *
 * One helper rather than the same `err instanceof Error ? … : String(err)`
 * ternary at eighteen `catch` sites. The non-Error arm is defensive at any one
 * of them — nothing a single caller can provoke, so it read as an untestable
 * branch eighteen times over — but real for the surface as a whole (a rejected
 * promise carrying a string, a thrown object from a dependency), and here it is
 * covered once instead of nowhere.
 */
export function failureResult(err: unknown): CallToolResult {
  return errorResult(errorMessage(err))
}

export function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
