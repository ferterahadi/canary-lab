import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { FlightManifest, FlightStage, PortifyManifest } from '@/shared/api/client'
import type { CoverageLedger, EvaluationExportTask, RunDetail } from '@/shared/api/types'
import { asRecord } from './FeatureSetupPanel'
import { evidenceOf, portifyWorkflowId, str } from './stage-meta'
import type { StageBandData } from './StageFacts'

// The band's data sources live outside the flight record: the coverage ledger,
// the boot run, the portify workflow, the on-disk config and the doc listing.
// Fetching all five on every stage switch would be five requests for a band
// that shows three tiles, so this resolves ONLY what the visible stage's band
// actually reads — keyed on the stage, refetched when it changes.
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
  /** Bumped on features-changed so a config edit re-reads the digest. */
  configRefreshKey?: number,
): StageBandData {
  const [ledger, setLedger] = useState<CoverageLedger | null>(null)
  const [boot, setBoot] = useState<RunDetail | null>(null)
  const [portify, setPortify] = useState<PortifyManifest | null>(null)
  const [config, setConfig] = useState<StageBandData['config']>(null)
  const [docBytes, setDocBytes] = useState<number | null>(null)
  const [summaryBytes, setSummaryBytes] = useState<number | null>(null)

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

  useEffect(() => {
    if (!needsLedger) { setLedger(null); return }
    let alive = true
    api.getFeatureCoverage(feature)
      .then((l) => { if (alive) setLedger(l) })
      // A feature with no PRD summary has no ledger; the tiles that read it
      // simply don't render, which is the honest outcome.
      .catch(() => { if (alive) setLedger(null) })
    return () => { alive = false }
  }, [feature, needsLedger])

  useEffect(() => {
    if (!needsBoot) { setBoot(null); return }
    let alive = true
    void (async () => {
      try {
        // Recorded evidence is a CACHE; the workspace is truth. A stage whose
        // evidence was probed at read time carries `{captured: N}` and no boot
        // at all — the probe can only see the envset on disk, never a dry-run
        // that happened days ago. So when no run id is recorded, find the
        // feature's most recent boot run and read the proof off that. Without
        // this the whole boot half of the stage is blank on every probed
        // flight, which is most older records.
        const runId = bootRunId ?? await latestBootRunId(feature)
        if (!runId) { if (alive) setBoot(null); return }
        const detail = await api.getRunDetail(runId)
        if (alive) setBoot(detail)
      } catch {
        if (alive) setBoot(null)
      }
    })()
    return () => { alive = false }
  }, [bootRunId, feature, needsBoot])

  useEffect(() => {
    if (!portifyId) { setPortify(null); return }
    let alive = true
    api.getPortify(portifyId)
      .then((m) => { if (alive) setPortify(m) })
      .catch(() => { if (alive) setPortify(null) })
    return () => { alive = false }
  }, [portifyId])

  useEffect(() => {
    if (!needsConfig) { setConfig(null); return }
    let alive = true
    api.getFeatureConfigDoc(feature)
      .then((doc) => { if (alive) setConfig(configCounts(doc.parsed.value)) })
      .catch(() => { if (alive) setConfig(null) })
    return () => { alive = false }
  }, [feature, needsConfig, configRefreshKey])

  useEffect(() => {
    if (!needsDocs) { setDocBytes(null); setSummaryBytes(null); return }
    let alive = true
    api.listFeatureDocs(feature)
      .then((listing) => {
        // Split source from generated: the `_prd-summary` artifacts are this
        // stage's OUTPUT, so counting them as "tokens read" would inflate the
        // input with what the input produced. Their size is the denominator of
        // the distillation ratio instead.
        const sum = (generated: boolean): number => listing.docs
          .filter((d) => d.generated === generated)
          .reduce((total, d) => total + d.sizeBytes, 0)
        const source = sum(false)
        const summary = sum(true)
        if (!alive) return
        setDocBytes(source > 0 ? source : null)
        setSummaryBytes(summary > 0 ? summary : null)
      })
      .catch(() => { if (alive) { setDocBytes(null); setSummaryBytes(null) } })
    return () => { alive = false }
  }, [feature, needsDocs])

  return { evalTask, ledger, boot, portify, config, docBytes, summaryBytes }
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
