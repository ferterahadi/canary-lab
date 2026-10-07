import { assertCoverageJobAvailable, createCoverageJobManifest } from './creation'
import { regeneratePrdSummary, type RegeneratePrdSummaryResult } from '../feature-docs'
import { runCoverageEngine, type RunCoverageEngineResult } from '../coverage-engine'
import type { AnnotateAdapter } from '../annotate-engine'
import type { SummarizeAdapter } from '../prd-summary'
import type { CoverageJobStore } from './store'
import type {
  CoverageJobKind,
  CoverageJobManifest,
  CoverageJobModels,
} from '../../../../../../../../shared/coverage/types'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../../../shared/workspace-events'

// Background driver + single-flight gate for coverage jobs. The start path
// rejects a second job of the same kind for the same feature while one runs
// (server-side guard — UI disabling is cosmetic). The actual work runs detached;
// progress is streamed into the manifest log (saved on each chunk → WS/poll).

export interface StartCoverageJobArgs {
  featuresDir: string
  logsDir: string
  feature: string
  kind: CoverageJobKind
  adapter?: SummarizeAdapter & AnnotateAdapter
  cwd?: string
  /** Resolved model+effort choices per engine stage, per agent — resolved by
   *  the route (launch override → workspace config → default) and persisted on
   *  the job record; the summary→coverage chain carries them forward. */
  models?: CoverageJobModels
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

export function startCoverageJob(args: StartCoverageJobArgs, deps: CoverageJobRunnerDeps): StartCoverageJobResult {
  const now = deps.now ?? (() => new Date().toISOString())
  const regenerate = deps.regenerate ?? regeneratePrdSummary
  const runEngine = deps.runEngine ?? runCoverageEngine
  const { store } = deps

  assertCoverageJobAvailable(store, args.feature, args.kind)

  let manifest: CoverageJobManifest = {
    ...createCoverageJobManifest({ feature: args.feature, kind: args.kind, log: '' }, { now, newJobId: deps.newJobId }),
    ...(args.chainedFromJobId ? { chainedFromJobId: args.chainedFromJobId } : {}),
    ...(args.models ? { models: args.models } : {}),
  }
  const { jobId } = manifest
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
          models: args.models?.prd,
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
            { featuresDir: args.featuresDir, logsDir: args.logsDir, feature: args.feature, kind: 'coverage', adapter: args.adapter, cwd: args.cwd, models: args.models, chainedFromJobId: jobId },
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
          models: args.models?.mapping,
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
