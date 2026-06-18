import crypto from 'crypto'
import {
  regeneratePrdSummary,
  runCoverageEngine,
  type RegeneratePrdSummaryResult,
  type RunCoverageEngineResult,
} from '../service'
import type { AnnotateAdapter } from '../annotate-engine'
import type { SummarizeAdapter } from '../prd-summary'
import type { CoverageJobStore } from './store'
import type { CoverageJobKind, CoverageJobManifest } from './types'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../workspace-events'

// Background driver + single-flight gate for coverage jobs. The start path
// rejects a second job of the same kind for the same feature while one runs
// (server-side guard — UI disabling is cosmetic). The actual work runs detached;
// progress is streamed into the manifest log (saved on each chunk → WS/poll).

export class CoverageJobConflictError extends Error {
  readonly statusCode = 409
  constructor(public readonly feature: string, public readonly kind: CoverageJobKind, public readonly existingJobId: string) {
    super(`a ${kind} job is already running for ${feature}`)
    this.name = 'CoverageJobConflictError'
  }
}

export interface StartCoverageJobArgs {
  featuresDir: string
  logsDir: string
  feature: string
  kind: CoverageJobKind
  adapter?: SummarizeAdapter & AnnotateAdapter
  cwd?: string
  /** Internal: set when this job was auto-spawned by a finishing summary job so
   *  the chain doesn't recurse. Not part of the public start contract. */
  chainedFromJobId?: string
}

export interface CoverageJobRunnerDeps {
  store: CoverageJobStore
  now?: () => string
  newJobId?: () => string
  regenerate?: typeof regeneratePrdSummary
  runEngine?: typeof runCoverageEngine
  workspaceEvents?: WorkspaceEventPublisher
}

export interface StartCoverageJobResult {
  manifest: CoverageJobManifest
  /** Resolves when the background work settles (used by tests; ignored by REST). */
  completion: Promise<void>
}

function defaultJobId(): string {
  return `cj_${crypto.randomBytes(6).toString('hex')}`
}

export function startCoverageJob(args: StartCoverageJobArgs, deps: CoverageJobRunnerDeps): StartCoverageJobResult {
  const now = deps.now ?? (() => new Date().toISOString())
  const newJobId = deps.newJobId ?? defaultJobId
  const regenerate = deps.regenerate ?? regeneratePrdSummary
  const runEngine = deps.runEngine ?? runCoverageEngine
  const { store } = deps

  // Single-flight: refuse a concurrent job of the same kind for this feature.
  const active = store.activeFor(args.feature, args.kind)
  if (active) throw new CoverageJobConflictError(args.feature, args.kind, active.jobId)

  const jobId = newJobId()
  let manifest: CoverageJobManifest = {
    jobId,
    feature: args.feature,
    kind: args.kind,
    ...(args.chainedFromJobId ? { chainedFromJobId: args.chainedFromJobId } : {}),
    status: 'running',
    startedAt: now(),
    log: '',
  }
  store.save(manifest)

  const append = (chunk: string) => {
    manifest = { ...manifest, log: manifest.log + chunk }
    store.save(manifest)
  }

  // R17: record the agent CLI session the moment it's pinned, so the Generating
  // screen can stream the structured AgentSessionView while the job runs.
  const onAgentSession = (session: { agent: 'claude' | 'codex'; sessionId: string }) => {
    manifest = { ...manifest, sessionRef: session }
    store.save(manifest)
  }

  const finishOk = (result: CoverageJobManifest['result'], extra?: Partial<CoverageJobManifest>) => {
    manifest = { ...manifest, ...extra, status: 'done', endedAt: now(), result }
    store.save(manifest)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: args.feature })
  }
  const finishErr = (err: unknown) => {
    manifest = { ...manifest, status: 'failed', endedAt: now(), error: err instanceof Error ? err.message : String(err) }
    store.save(manifest)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: args.feature })
  }

  const completion = (async () => {
    try {
      if (args.kind === 'summary') {
        const res: RegeneratePrdSummaryResult = await regenerate({
          featuresDir: args.featuresDir,
          feature: args.feature,
          adapter: args.adapter,
          cwd: args.cwd,
          onOutput: append,
          onAgentSession,
        })
        // Summary + Coverage are one exercise (R14): on a successful summary,
        // immediately chain the coverage engine so mappings refresh against the
        // new requirements with no second click. Single-flight still applies —
        // if a coverage job is somehow already running, skip the chain quietly.
        let chainedJobId: string | undefined
        try {
          append('\n[chain] summary done — starting coverage engine…\n')
          const chained = startCoverageJob(
            { featuresDir: args.featuresDir, logsDir: args.logsDir, feature: args.feature, kind: 'coverage', adapter: args.adapter, cwd: args.cwd, chainedFromJobId: jobId },
            deps,
          )
          chainedJobId = chained.manifest.jobId
        } catch (chainErr) {
          append(`[chain] coverage not started: ${chainErr instanceof Error ? chainErr.message : String(chainErr)}\n`)
        }
        finishOk({ requirementCount: res.summary.requirements.filter((r) => !r.deprecated).length }, chainedJobId ? { chainedJobId } : undefined)
      } else {
        const res: RunCoverageEngineResult = await runEngine({
          featuresDir: args.featuresDir,
          logsDir: args.logsDir,
          feature: args.feature,
          adapter: args.adapter,
          cwd: args.cwd,
          onOutput: append,
          onAgentSession,
        })
        finishOk({ applied: res.applied.length })
      }
    } catch (err) {
      finishErr(err)
    }
  })()

  return { manifest, completion }
}
