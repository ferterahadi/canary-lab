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
  /** coverage jobs: store proposals for accept/reject instead of writing tags. */
  reviewMode?: boolean
  adapter?: SummarizeAdapter & AnnotateAdapter
  cwd?: string
}

export interface CoverageJobRunnerDeps {
  store: CoverageJobStore
  now?: () => string
  newJobId?: () => string
  regenerate?: typeof regeneratePrdSummary
  runEngine?: typeof runCoverageEngine
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
    ...(args.kind === 'coverage' ? { reviewMode: Boolean(args.reviewMode) } : {}),
    status: 'running',
    startedAt: now(),
    log: '',
  }
  store.save(manifest)

  const append = (chunk: string) => {
    manifest = { ...manifest, log: manifest.log + chunk }
    store.save(manifest)
  }

  const finishOk = (result: CoverageJobManifest['result']) => {
    manifest = { ...manifest, status: 'done', endedAt: now(), result }
    store.save(manifest)
  }
  const finishErr = (err: unknown) => {
    manifest = { ...manifest, status: 'failed', endedAt: now(), error: err instanceof Error ? err.message : String(err) }
    store.save(manifest)
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
        })
        finishOk({ requirementCount: res.summary.requirements.filter((r) => !r.deprecated).length })
      } else {
        const res: RunCoverageEngineResult = await runEngine({
          featuresDir: args.featuresDir,
          logsDir: args.logsDir,
          feature: args.feature,
          adapter: args.adapter,
          reviewMode: args.reviewMode,
          cwd: args.cwd,
          onOutput: append,
        })
        finishOk({ applied: res.applied.length, proposed: res.proposed.length, reviewMode: Boolean(args.reviewMode) })
      }
    } catch (err) {
      finishErr(err)
    }
  })()

  return { manifest, completion }
}
