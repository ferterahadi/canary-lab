import crypto from 'crypto'
import {
  applyExternalCoverageMappings,
  buildCoverageMappingContext,
  featureExists,
  hasPrdSummary,
  FeatureNotFoundError,
  type ApplyExternalCoverageResult,
  type CoverageMappingContext,
} from '../service'
import { CoverageJobConflictError } from './runner'
import type { CoverageJobStore } from './store'
import type { CoverageJobManifest } from './types'
import type { ProposedMapping } from '../../../../../../../../shared/coverage/types'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../../../shared/workspace-events'

// Offloaded ("external") coverage: the calling MCP client does the annotate-pass
// itself — Canary spawns NO local agent. start_external_coverage hands the client
// the mapping context; the client returns `mappings`; submit_external_coverage
// writes the tags (canonical tag-writer) and recomputes the ledger. The job
// record (producer:'external', no sessionRef) lets the UI monitor it without an
// AgentSessionView. The internal start_coverage_job path is untouched.

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
 *  the client must run regenerate_prd_summary first. Throws FeatureNotFoundError
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
