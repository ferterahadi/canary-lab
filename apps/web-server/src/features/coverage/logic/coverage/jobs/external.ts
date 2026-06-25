import crypto from 'crypto'
import {
  applyExternalCoverageMappings,
  applyExternalSummary,
  buildCoverageMappingContext,
  buildSummaryAuthoringContext,
  featureExists,
  hasPrdSummary,
  FeatureNotFoundError,
  type ApplyExternalCoverageResult,
  type ApplyExternalSummaryResult,
  type CoverageMappingContext,
  type SummaryAuthoringContext,
} from '../service'
import { CoverageJobConflictError } from './runner'
import type { CoverageJobStore } from './store'
import type { CoverageJobManifest } from './types'
import type { ParsedRequirement } from '../prd-summary'
import type { ProposedMapping, VariantDimension } from '../../../../../../../../shared/coverage/types'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../../../shared/workspace-events'

// Offloaded ("external") coverage + PRD summary: the calling MCP client does the
// agent work itself — Canary spawns NO local agent. The start_* tool hands the
// client the context/prompt; the client returns its result; the submit_* tool
// writes it through the canonical writer (tag-writer / summary assembler) and
// recomputes. The job record (producer:'external', no sessionRef) lets the UI
// monitor it without an AgentSessionView. Server-spawned variants no longer
// exist on the MCP surface — they remain only on the GUI's REST routes.

export interface StartExternalCoverageArgs {
  featuresDir: string
  logsDir: string
  feature: string
  sessionId: string
  clientKind?: string
  conversationName?: string
  sessionUrl?: string
  now?: () => string
  newJobId?: () => string
}

export type StartExternalCoverageResult =
  | { kind: 'needs-summary'; feature: string }
  | { kind: 'started'; manifest: CoverageJobManifest; context: CoverageMappingContext }

export interface ExternalCoverageDeps {
  store: CoverageJobStore
  workspaceEvents?: WorkspaceEventPublisher
}

function defaultJobId(): string {
  return `cj_${crypto.randomBytes(6).toString('hex')}`
}

/** Create an external coverage job and return the mapping context for the client.
 *  Returns `needs-summary` (no job created) when the feature has no PRD summary —
 *  the client must run start_external_summary (then submit_external_summary) first.
 *  Throws FeatureNotFoundError
 *  for an unknown feature and CoverageJobConflictError if a coverage job (of
 *  either producer) is already running for the feature. */
export function startExternalCoverage(
  args: StartExternalCoverageArgs,
  deps: ExternalCoverageDeps,
): StartExternalCoverageResult {
  if (!featureExists(args.featuresDir, args.feature)) throw new FeatureNotFoundError(args.feature)
  if (!hasPrdSummary(args.featuresDir, args.feature)) return { kind: 'needs-summary', feature: args.feature }

  const now = args.now ?? (() => new Date().toISOString())
  const newJobId = args.newJobId ?? defaultJobId

  // Single-flight: one coverage job per feature, internal or external alike.
  const active = deps.store.activeFor(args.feature, 'coverage')
  if (active) throw new CoverageJobConflictError(args.feature, 'coverage', active.jobId)

  const context = buildCoverageMappingContext({ featuresDir: args.featuresDir, feature: args.feature })

  const manifest: CoverageJobManifest = {
    jobId: newJobId(),
    feature: args.feature,
    kind: 'coverage',
    status: 'running',
    startedAt: now(),
    log: '[external] coverage offloaded to the calling client — Canary will recompute on submit_external_coverage\n',
    producer: 'external',
    ...(args.clientKind ? { externalClientKind: args.clientKind } : {}),
    externalSessionId: args.sessionId,
    ...(args.conversationName ? { externalConversationName: args.conversationName } : {}),
    ...(args.sessionUrl ? { externalSessionUrl: args.sessionUrl } : {}),
  }
  deps.store.save(manifest)
  // The job now exists and is `running` — tell every open client so the feature's
  // coverage pill flips to "Generating" and an open ledger re-attaches to the
  // Generating screen live, without a refresh (cl_ws-driven-state). Same event
  // the submit path uses; the client reaction (re-list states / re-attach) is
  // idempotent for both the start and the finish of a coverage job.
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: args.feature })
  return { kind: 'started', manifest, context }
}

export interface SubmitExternalCoverageArgs {
  featuresDir: string
  logsDir: string
  jobId: string
  mappings: ProposedMapping[]
  now?: () => string
}

export interface SubmitExternalCoverageResult {
  manifest: CoverageJobManifest
  result: ApplyExternalCoverageResult
}

/** Apply the client's mappings, mark the external job done, and emit
 *  coverage-changed. Tolerates a job that was reconciled to `aborted` by a server
 *  restart (the client kept working off-box) — it recomputes and finalizes
 *  anyway. Throws for an unknown job or a non-external one. */
export function submitExternalCoverage(
  args: SubmitExternalCoverageArgs,
  deps: ExternalCoverageDeps,
): SubmitExternalCoverageResult {
  const now = args.now ?? (() => new Date().toISOString())
  const job = deps.store.get(args.jobId)
  if (!job) throw new Error(`coverage job not found: ${args.jobId}`)
  if (job.producer !== 'external') throw new Error('only external coverage jobs can be submitted through this tool')

  const result = applyExternalCoverageMappings({
    featuresDir: args.featuresDir,
    logsDir: args.logsDir,
    feature: job.feature,
    mappings: args.mappings,
    now: now(),
  })

  const manifest: CoverageJobManifest = {
    ...job,
    status: 'done',
    endedAt: now(),
    log: job.log + `[external] applied ${result.applied.length} covers tag(s); ledger recomputed\n`,
    result: { applied: result.applied.length },
  }
  deps.store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: job.feature })
  return { manifest, result }
}

// ---------------------------------------------------------------------------
// External (offloaded) PRD summary — same shape as external coverage, kind:
// 'summary'. start_external_summary creates the job + returns the authoring
// context; submit_external_summary reconciles ids and writes the sidecar.
// ---------------------------------------------------------------------------

export interface StartExternalSummaryArgs {
  featuresDir: string
  logsDir: string
  feature: string
  sessionId: string
  clientKind?: string
  conversationName?: string
  sessionUrl?: string
  now?: () => string
  newJobId?: () => string
}

export type StartExternalSummaryResult =
  | { kind: 'needs-docs'; feature: string }
  | { kind: 'started'; manifest: CoverageJobManifest; context: SummaryAuthoringContext }

/** Create an external PRD-summary job and return the authoring context for the
 *  client. Returns `needs-docs` (no job created) when the feature has no source
 *  docs to summarize. Throws FeatureNotFoundError for an unknown feature and
 *  CoverageJobConflictError if a summary job is already running. */
export function startExternalSummary(
  args: StartExternalSummaryArgs,
  deps: ExternalCoverageDeps,
): StartExternalSummaryResult {
  if (!featureExists(args.featuresDir, args.feature)) throw new FeatureNotFoundError(args.feature)
  const built = buildSummaryAuthoringContext({ featuresDir: args.featuresDir, feature: args.feature })
  if (built.kind === 'needs-docs') return { kind: 'needs-docs', feature: args.feature }

  const now = args.now ?? (() => new Date().toISOString())
  const newJobId = args.newJobId ?? defaultJobId

  // Single-flight: one summary job per feature, internal or external alike.
  const active = deps.store.activeFor(args.feature, 'summary')
  if (active) throw new CoverageJobConflictError(args.feature, 'summary', active.jobId)

  const manifest: CoverageJobManifest = {
    jobId: newJobId(),
    feature: args.feature,
    kind: 'summary',
    status: 'running',
    startedAt: now(),
    log: '[external] PRD summary offloaded to the calling client — Canary will write the summary on submit_external_summary\n',
    producer: 'external',
    ...(args.clientKind ? { externalClientKind: args.clientKind } : {}),
    externalSessionId: args.sessionId,
    ...(args.conversationName ? { externalConversationName: args.conversationName } : {}),
    ...(args.sessionUrl ? { externalSessionUrl: args.sessionUrl } : {}),
  }
  deps.store.save(manifest)
  // Flip the coverage pill to "Generating" and re-attach an open ledger to the
  // Generating screen live (cl_ws-driven-state) — same event the submit path uses.
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: args.feature })
  return { kind: 'started', manifest, context: built.context }
}

export interface SubmitExternalSummaryArgs {
  featuresDir: string
  jobId: string
  requirements: ParsedRequirement[]
  /** The feature's variant dimension (D1), if the client declared one. */
  variantDimension?: VariantDimension
  now?: () => string
}

export interface SubmitExternalSummaryResult {
  manifest: CoverageJobManifest
  result: ApplyExternalSummaryResult
}

/** Apply the client's requirements, mark the external summary job done, and emit
 *  coverage-changed. Throws for an unknown job or a non-external/non-summary one. */
export function submitExternalSummary(
  args: SubmitExternalSummaryArgs,
  deps: ExternalCoverageDeps,
): SubmitExternalSummaryResult {
  const now = args.now ?? (() => new Date().toISOString())
  const job = deps.store.get(args.jobId)
  if (!job) throw new Error(`coverage job not found: ${args.jobId}`)
  if (job.producer !== 'external') throw new Error('only external summary jobs can be submitted through this tool')
  if (job.kind !== 'summary') throw new Error(`job ${args.jobId} is a ${job.kind} job, not a summary job`)

  const result = applyExternalSummary({
    featuresDir: args.featuresDir,
    feature: job.feature,
    requirements: args.requirements,
    ...(args.variantDimension ? { variantDimension: args.variantDimension } : {}),
    now: now(),
  })

  const manifest: CoverageJobManifest = {
    ...job,
    status: 'done',
    endedAt: now(),
    log: job.log + `[external] wrote PRD summary with ${result.summary.requirements.length} requirement(s); ledger recomputed\n`,
    result: { requirementCount: result.summary.requirements.length },
  }
  deps.store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: job.feature })
  return { manifest, result }
}
