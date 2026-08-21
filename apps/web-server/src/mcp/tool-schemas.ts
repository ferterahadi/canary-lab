// Shared surface for the MCP tool groups: input schemas, profile arrays, the
// dependency interface, and the result/format helpers every group calls.
//
// Split out of tools.ts so the four domain groups in ./tool-groups/ can import
// it without importing tools.ts back — tools.ts imports the groups, so anything
// they share has to live below both of them.

import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../features/runs/logic/run-store'
import type { RunDetail } from '../features/runs/logic/run-store'
import type { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import type { ClientKind } from '../../../../shared/run-mode'
import type { DirtySpecStore } from '../features/runs/logic/dirty-specs/store'
import { type ResolveVerificationInput } from '../features/coverage/logic/verification'
import { buildTestReviewPacket, deterministicEvaluationRewrite, evaluationTextSlots } from '../features/evaluation/logic/test-review-export'
import { type WorkspaceEventPublisher } from '../shared/workspace-events'
import type {
  PortifyManifest,
  StartExternalPortifyInput,
  StartExternalPortifyResult,
} from '../features/portify/logic/runtime/types'

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

// The external-submission shapes (coverage mappings, summary requirements, the
// variant dimension) moved to the coverage logic layer so the flight's
// external-work responders validate with the SAME schemas these tools declare —
// re-exported here so the tool groups keep one import home.
export {
  coverageMappingInput,
  summaryRequirementInput,
  variantDimensionInput,
} from '../features/coverage/logic/coverage/external-submissions'

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
      kind: 'getting-started-busy'
      active: {
        sessionId: string
        workflow: 'run' | 'flight'
        owner: 'internal' | 'external'
        target: { kind: 'run' | 'flight'; id: string } | null
      }
      message: string
    }
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
  /** External producer: reopen a VERIFIED workflow (`ready-to-save` → `editing`)
   *  so the client can act on human feedback without discarding the worktree, and
   *  hand back the feedback prompt that restates the constraints. */
  reviseExternalPortify?: (workflowId: string, feedback: string) => { manifest: PortifyManifest; instructions: string }
  /** The retry playbook for a failed double-boot, rendered for an external client.
   *  Null unless the workflow is external and parked at `editing` on a failure. */
  externalPortifyRetryPrompt?: (workflowId: string) => string | null
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
