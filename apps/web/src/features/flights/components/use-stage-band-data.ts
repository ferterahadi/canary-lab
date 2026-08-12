import { useEffect } from 'react'
import * as api from '@/shared/api/client'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { usePortify, usePortifyWorkflow } from '@/features/portify'
import type { FlightManifest, FlightStage } from '@/shared/api/client'
import type { CoverageLedger, EvaluationExportTask, RunDetail } from '@/shared/api/types'
import { asRecord } from './FeatureSetupPanel'
import { evidenceOf, portifyWorkflowId, str } from './stage-meta'
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
// exist for this flight, drops its tile rather than rendering a zero.

export function useStageBandData(
  flight: FlightManifest,
  stage: FlightStage,
  companion: FlightStage | null,
  /** The export task the Evaluation Report stage pinned, resolved by the caller
   *  from the live export store (which already holds every task). */
  evalTask: EvaluationExportTask | null,
): StageBandData {

  const feature = flight.feature
  const stageKey = stage.key
  // The boot run id rides the env-capture companion's evidence (the folded half
  // of the Suite setup row), or the stage's own when rendered standalone.
  const bootRunId = stageKey === 'scaffold' || stageKey === 'env-capture'
    ? str(evidenceOf(companion ?? stage), 'runId') ?? str(evidenceOf(stage), 'runId')
    : null
  const portifyId = portifyWorkflowId(stage)
  const needsLedger = stageKey === 'specs-coverage' || stageKey === 'evaluation-export'
  const needsConfig = stageKey === 'scout'
  const needsBoot = stageKey === 'scaffold' || stageKey === 'env-capture'
  const needsDocs = stageKey === 'docs'

  // `coverage` is the live trigger: the specs↔coverage loop publishes
  // `coverage-changed` the moment each pass's mapping lands, and the stage stays
  // MOUNTED across the whole loop. Fetched once, the composition card kept the
  // pre-mapping snapshot and a settled stage showed "100% covered" beside
  // "Untested 18" — one card apart, from the same ledger. A feature with no PRD
  // summary has no ledger at all; the tiles that read it simply don't render.
  const { value: ledger } = useLiveResource<CoverageLedger>(
    'coverage',
    needsLedger ? feature : null,
    (f) => api.getFeatureCoverage(f),
  )

  // Keyed on the run id when the stage recorded one, else on the feature (the
  // probe path below). `repos` is the live trigger: a re-boot writes a new run,
  // and the same features refresh that carries it re-reads this proof.
  const { value: boot } = useLiveResource<RunDetail>(
    'repos',
    needsBoot ? (bootRunId ?? feature) : null,
    async () => {
      // Recorded evidence is a CACHE; the workspace is truth. A stage whose
      // evidence was probed at read time carries `{captured: N}` and no boot at
      // all — the probe can only see the envset on disk, never a dry-run that
      // happened days ago. So when no run id is recorded, find the feature's
      // most recent boot run and read the proof off that. Without this the whole
      // boot half of the stage is blank on every probed flight, which is most
      // older records.
      const runId = bootRunId ?? await latestBootRunId(feature)
      return runId ? await api.getRunDetail(runId) : null
    },
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
  const livePortify = usePortifyWorkflow(portifyId)
  const { loadPortify } = usePortify()
  useEffect(() => {
    if (portifyId && !livePortify) void loadPortify(portifyId)
  }, [portifyId, livePortify, loadPortify])

  // `repos` is bumped on `features-changed`, which is what a config edit
  // publishes — so the digest re-reads itself instead of waiting for a remount.
  const { value: config } = useLiveResource<StageBandData['config']>(
    'repos',
    needsConfig ? feature : null,
    async (f) => configCounts((await api.getFeatureConfigDoc(f)).parsed.value),
  )

  // `coverage` is the live trigger: the `_prd-summary` artifacts are written by
  // the SECOND half of this merged row, while the pane is already mounted and
  // showing the first half's tiles, and their write publishes `coverage-changed`.
  // Fetched once, this listing stayed at the pre-distillation snapshot and
  // "Distilled to" was missing until the user reloaded.
  const { value: docSizes } = useLiveResource<DocSizes>(
    'coverage',
    needsDocs ? feature : null,
    async (f) => {
      // Split source from generated: the `_prd-summary` artifacts are this
      // stage's OUTPUT, so counting them as "tokens read" would inflate the
      // input with what the input produced. Their size is the denominator of
      // the distillation ratio instead.
      const listing = await api.listFeatureDocs(f)
      const sum = (generated: boolean): number => listing.docs
        .filter((d) => d.generated === generated)
        .reduce((total, d) => total + d.sizeBytes, 0)
      return { source: sum(false), summary: sum(true) }
    },
  )

  return {
    evalTask,
    ledger,
    boot,
    portify: livePortify ?? null,
    config,
    // A zero total means "no docs", which drops the tile rather than showing 0.
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
  const runs = await api.listRuns({ feature })
  // listRuns is newest-first.
  return runs.find((r) => r.executionType === 'boot')?.runId ?? null
}

/** Service and port-slot counts off the feature config document. Counts the
 *  START COMMANDS, which is what actually boots, rather than the repos. */
function configCounts(config: unknown): StageBandData['config'] {
  const root = asRecord(config)
  const repos = Array.isArray(root?.repos) ? root.repos : []
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
