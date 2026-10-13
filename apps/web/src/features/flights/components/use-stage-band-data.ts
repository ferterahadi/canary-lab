import * as runsApi from '@/shared/api/runs'
import * as configApi from '@/shared/api/config'
import * as coverageApi from '@/shared/api/coverage'
import { ApiError } from '@/shared/api/internal'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { useLiveCoverage } from '@/shared/state/use-live-coverage'
import { usePortifyDetail } from '@/features/portify/state/PortifyContext'
import type { FlightManifest, FlightStage } from '@shared/flights/types'
import type { EvaluationExportTaskView } from '@shared/evaluation-export-types'
import type { FeatureDocsListing } from '@shared/coverage/feature-docs'
import type { CoverageLedger } from '@shared/coverage/types'
import type { RunDetail } from '@shared/run-detail'
import { asRecord } from '../lib/as-record'
import { evidenceOf, portifyWorkflowId, progressOf, str } from './stage-meta'
import type { StageBandData } from './StageFacts'

// The band's data sources live outside the flight record: the coverage ledger,
// the boot run, the portify workflow, the on-disk config and the doc listing.
// Fetching all of them on every stage switch would be five requests for a band
// that shows three tiles, so this resolves ONLY what the visible stage's band
// actually reads — keyed on the stage, refetched when it changes. The portify
// workflow is the exception: it comes off the live `/ws/portify` store rather
// than a fetch, because it keeps changing while the stage is open.
//
// Every field stays optional: a source that hasn't resolved yet, or doesn't
// exist for this flight, leaves its frontend-owned tile as a skeleton rather
// than rendering a zero or changing the stage's shape.
//
// `pending` is what tells the pane which of those two it is. A stage settles by
// PRODUCING its evidence, but the pane still has to READ it — and these reads are
// REST calls that resolve a frame or two after the flight record does. Without
// the flag the pane rendered its record-backed tiles first and then, a fetch
// later, inserted the ledger-backed ones and the whole Composition card beneath
// them, so every visit to Test authoring & coverage moved under the reader.

export function useStageBandData(
  flight: FlightManifest,
  stage: FlightStage,
  companion: FlightStage | null,
  /** The export task the Evaluation Report stage pinned, resolved by the caller
   *  from the live export store (which already holds every task). */
  evalTask: EvaluationExportTaskView | null,
): StageBandData {

  const feature = flight.feature
  const stageKey = stage.key
  // The boot run id rides the env-capture companion's evidence (the folded half
  // of the Suite setup row), or the stage's own when rendered standalone.
  const setupStage = companion ?? stage
  const bootRunId = stageKey === 'scaffold' || stageKey === 'env-capture'
    ? str(asRecord(evidenceOf(setupStage).boot) ?? {}, 'runId')
      ?? str(evidenceOf(setupStage), 'runId')
      ?? str(progressOf(setupStage), 'runId')
      ?? str(evidenceOf(stage), 'runId')
    : null
  const portifyId = portifyWorkflowId(stage)
  const needsLedger = stageKey === 'specs-coverage' || stageKey === 'evaluation-export'
  const needsBoot = stageKey === 'scaffold' || stageKey === 'env-capture'
  const needsConfig = stageKey === 'scout' || needsBoot
  const configVersion = useInvalidationKey('configuration', feature)
  const globalConfigVersion = useInvalidationKey('configuration')
  const needsDocs = stageKey === 'docs'
  // `coverage` is the live trigger: the specs↔coverage loop publishes
  // `coverage-changed` the moment each pass's mapping lands, and the stage stays
  // MOUNTED across the whole loop. Fetched once, the composition card kept the
  // pre-mapping snapshot and a settled stage showed "100% covered" beside
  // "Untested 18" — one card apart, from the same ledger. A feature with no PRD
  // summary has no ledger at all; the tiles that read it simply don't render.
  const { value: ledger, loading: ledgerLoading, confirmed: ledgerConfirmed } = useLiveCoverage(needsLedger ? feature : null)

  // Keyed on the run id when the stage recorded one, else on the feature (the
  // probe path below). `repos` is the live trigger: a re-boot writes a new run,
  // and the same features refresh that carries it re-reads this proof.
  const { value: boot, loading: bootLoading, error: bootError } = useLiveResource<RunDetail>(
    'repos',
    needsBoot ? (bootRunId ?? feature) : null,
    async () => {
      // Workspace evidence can pin an ordinary test run that proved readiness.
      // Only legacy evidence without a reference needs the boot-only fallback;
      // never replace a pinned historical proof with an unrelated later run.
      const runId = bootRunId ?? await latestBootRunId(feature)
      if (!runId) return null
      try {
        return await runsApi.getRunDetail(runId)
      } catch (error) {
        // Cleanup may remove the run; recorded service evidence still survives.
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      }
    },
    { cache: 'boot-proof', reconcileMs: 5000, pauseWhenHidden: true },
  )

  // The workflow id is pinned at stage START (the stage's first setProgress), so
  // a one-shot fetch here resolved a manifest that had no verification and no
  // diff yet — and never re-ran, because the id it keys on never changes. The
  // side-by-side proof and the port changes only appeared after a page reload.
  // `/ws/portify` is the task-scoped stream for exactly this workflow and the
  // app already holds it: the store pushes the FULL manifest on every attempt,
  // verification and save, so reading it keeps both panels live. The one-shot
  // hydrate covers the cold-load case — the WS snapshot omits details for
  // terminal workflows, which is every settled flight.
  const { manifest: livePortify, loading: portifyLoading, error: portifyError, missing: portifyMissing, retry: retryPortify } = usePortifyDetail(portifyId)

  // `repos` is bumped on `features-changed`, which is what a config edit
  // publishes — so the digest re-reads itself instead of waiting for a remount.
  const { value: config, loading: configLoading, error: configError } = useLiveResource<StageBandData['config']>(
    'repos',
    needsConfig ? feature : null,
    async (f) => configCounts((await configApi.getFeatureConfigDoc(f)).parsed.value),
    { cache: 'config-counts', reconcileMs: 5000, pauseWhenHidden: true, refreshKey: `${configVersion}:${globalConfigVersion}` },
  )

  // `coverage` is the live trigger: the `_prd-summary` artifacts are written by
  // the SECOND half of this merged row, while the pane is already mounted and
  // showing the first half's tiles, and their write publishes `coverage-changed`.
  // Fetched once, this listing stayed at the pre-distillation snapshot and
  // "Distilled to" was missing until the user reloaded.
  //
  // The FULL listing is kept (not just the byte sums the tiles read) and rides
  // out on `docsListing`, because the docs panel and the requirements fork show
  // the same files — each used to fetch it again on the same event.
  const { value: docsListing, loading: docsLoading } = useLiveResource<FeatureDocsListing>(
    'coverage',
    needsDocs ? feature : null,
    (f) => coverageApi.listFeatureDocs(f),
    { cache: 'docs-listing' },
  )
  // Split source from generated: the `_prd-summary` artifacts are this stage's
  // OUTPUT, so counting them as "tokens read" would inflate the input with what
  // the input produced. Their size is the denominator of the distillation ratio.
  const docSum = (generated: boolean): number => (docsListing?.docs ?? [])
    .filter((d) => d.generated === generated)
    .reduce((total, d) => total + d.sizeBytes, 0)
  const docSizes: DocSizes | null = docsListing ? { source: docSum(false), summary: docSum(true) } : null

  return {
    // A FIRST resolve only. `loading` is also true during a refetch, and the
    // ledger refetches on every `coverage-changed` the authoring loop publishes:
    // treating that as pending would flick a settled band back to placeholders
    // once per pass, with the previous ledger sitting right there in hand.
    pending: (ledgerLoading && !ledger)
      || (bootLoading && !boot)
      || (configLoading && !config)
      || (docsLoading && !docSizes)
      || portifyLoading,
    evalTask,
    ledger,
    ledgerConfirmed,
    boot: bootError ? null : boot,
    setupError: needsBoot ? configError ?? bootError : null,
    portify: livePortify ?? null,
    portifyRecovery: { error: portifyError, missing: portifyMissing, retry: retryPortify },
    config: configError ? null : config,
    docsListing,
    // A zero total means "no docs". The frontend keeps the Source docs slot but
    // leaves it unfilled rather than presenting zero as a measured result.
    docBytes: docSizes && docSizes.source > 0 ? docSizes.source : null,
    summaryBytes: docSizes && docSizes.summary > 0 ? docSizes.summary : null,
  }
}

/** Source vs generated doc bytes — the two ends of the distillation ratio. */
interface DocSizes {
  source: number
  summary: number
}

/** The feature's most recent dry-run boot. `aborted` is the NORMAL terminal
 *  state for one — env-capture tears the boot down in a `finally` once every
 *  service reports ready — so the status is not a filter here; the per-service
 *  statuses on the manifest are what say whether it came up. */
async function latestBootRunId(feature: string): Promise<string | null> {
  const runs = await runsApi.listRuns({ feature })
  // listRuns is newest-first.
  return runs.find((r) => r.executionType === 'boot')?.runId ?? null
}

/** Service and port-slot counts off the feature config document. Counts the
 *  START COMMANDS, which is what actually boots, rather than the repos. */
function configCounts(config: unknown): StageBandData['config'] {
  const root = asRecord(config)
  // A failed/unsupported parse is unknown, never proof of an empty service list.
  if (!root || !Array.isArray(root.repos)) return null
  const repos = root.repos
  let services = 0
  const slots = new Set<string>()
  for (const repo of repos) {
    const commands = Array.isArray(asRecord(repo)?.startCommands) ? asRecord(repo)!.startCommands as unknown[] : []
    services += commands.length
    for (const command of commands) {
      const ports = Array.isArray(asRecord(command)?.ports) ? asRecord(command)!.ports as unknown[] : []
      for (const port of ports) {
        const name = asRecord(port)?.name
        if (typeof name === 'string') slots.add(name)
      }
    }
  }
  return { services, portSlots: slots.size }
}
