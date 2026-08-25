import fs from 'fs'
import path from 'path'
import type { FlightStage, FlightStageKey } from './types'
import { readDocsCollection } from '../../coverage/logic/coverage/docs-collection'
import { readPrdSummary } from '../../coverage/logic/coverage/prd-summary-render'
import { computeFeatureCoverage, resolveFeatureDir } from '../../coverage/logic/coverage/service'
import { listEvaluationExportTasks } from '../../evaluation/logic/evaluation-export-store'
import { readOverlay } from '../../portify/logic/runtime/overlay'
import { PortifyRunStore } from '../../portify/logic/runtime/store'
import { readRunSummary, runCounts } from '../../runs/logic/run-detail'
import { loadFeatures } from '../../../shared/feature-loader'
import { startCommandPortSlotCounts } from '../../../../../../shared/launcher/port-injectability'
import { listRuns } from '../../runs/logic/run-store'
import { findBootProof } from './stage-evidence'
import { readManifest } from '../../runs/logic/runtime/manifest'
import { buildRunPaths, runDirFor } from '../../runs/logic/runtime/run-paths'

// Read-time stage evidence, probed from the workspace for stages that never
// recorded their own. Stored evidence is a CACHE of what the conductor measured;
// the workspace is the source of truth, so a stage with an empty cache reads the
// artifacts directly instead of rendering as blank.
//
// This is the `/flights/:id/remedy` pattern (live `git status`, never persisted)
// applied to evidence, and it deliberately serves three populations at once with
// no migration, no backfill and no user action:
//   - derived flights (a feature whose stages were completed outside the
//     conductor — see derived-stages.ts; there is no record to read),
//   - flights recorded before a given evidence key existed,
//   - flights interrupted before a stage adapter wrote its evidence.
//
// Probes are LAZY per stage: the coverage ledger parses every spec file, so it
// must not run on a flight read whose specs-coverage stage already has evidence.

export interface WorkspaceEvidenceDeps {
  featuresDir: string
  logsDir: string
}

export type EvidenceBlock = Record<string, unknown>

/** The number of files in the captured envset — `env` when named, otherwise the
 *  first non-empty envset directory (the derived rail asks "was the environment
 *  ever captured", not "for this specific env"). */
function capturedEnvsetCount(featureDir: string, env?: string): number | undefined {
  const envsetsDir = path.join(featureDir, 'envsets')
  const count = (dir: string): number => {
    try {
      return fs.readdirSync(dir).length
    } catch {
      return 0
    }
  }
  if (env !== undefined) {
    const captured = count(path.join(envsetsDir, env))
    return captured > 0 ? captured : undefined
  }
  let dirs: fs.Dirent[]
  try {
    dirs = fs.readdirSync(envsetsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const captured = count(path.join(envsetsDir, d.name))
    if (captured > 0) return captured
  }
  return undefined
}

/** Suite setup, shaped exactly like the conducted env-capture stage's own
 *  evidence: what was captured, and the boot that proved it. Either half alone
 *  is a real answer — an app with no env files reports the boot and nothing
 *  captured, which is the whole reason this stage stopped being envset-gated. */
function envCaptureEvidence(deps: WorkspaceEvidenceDeps, feature: string, featureDir: string, env?: string): EvidenceBlock | undefined {
  const captured = capturedEnvsetCount(featureDir, env)
  const proof = findBootProof(deps.logsDir, feature)
  if (captured === undefined && !proof) return undefined
  return {
    ...(captured !== undefined ? { captured } : {}),
    ...(proof ? { boot: { runId: proof.runId, services: proof.services } } : {}),
  }
}

/** Source requirement docs — the same collection the coverage ledger reads, so
 *  the stage's count and the ledger's can't disagree. */
function docsEvidence(featureDir: string): EvidenceBlock | undefined {
  const docs = readDocsCollection(featureDir).entries.map((e) => e.relPath)
  return docs.length > 0 ? { docs } : undefined
}

function prdSummaryEvidence(featureDir: string): EvidenceBlock | undefined {
  const summary = readPrdSummary(featureDir)
  const requirementCount = summary?.requirements?.length
  return requirementCount ? { requirementCount } : undefined
}

/** Live authoring and mapping evidence. The spec count proves tests exist; the
 *  ledger state says whether requirement mapping ran; the percentage is only a
 *  claim after that point. */
function specsCoverageEvidence(deps: WorkspaceEvidenceDeps, feature: string): EvidenceBlock | undefined {
  const ledger = computeFeatureCoverage({ featuresDir: deps.featuresDir, logsDir: deps.logsDir, feature })
  return {
    coveragePct: ledger.coveragePct,
    mappingState: ledger.state?.coverage,
    requirementCount: ledger.requirements.length,
    testsWritten: ledger.tests.length,
    covered: ledger.totals.covered,
    total: ledger.totals.total,
  }
}

/** How many files the portify agent had to rewrite. A saved no-op overlay
 *  (`touchedFiles: []`) is the meaningful "already port-injectable" answer, so
 *  this reports 0 rather than nothing — the two read differently to the user.
 *
 *  The `workflowId` of the SAVED workflow that produced the overlay rides along:
 *  the stage's facts row is gated on it, and so is the drill-through to the
 *  portify timeline. Without it a portified feature shows a bare sentence and no
 *  way into the proof — the "re-run portify to get a drill-through" gap this
 *  read-time fill exists to close. Omitted when no saved workflow is on record
 *  (a hand-written overlay), which the facts row already tolerates.
 *  `PortifyRunStore.list()` is a pure index read — reconciliation only happens
 *  through the explicit `reconcileInterrupted`, so probing writes nothing. */
function savedPortifyWorkflowId(logsDir: string, feature: string): string | undefined {
  return new PortifyRunStore(logsDir)
    .list()
    .filter((w) => w.feature === feature && w.status === 'saved')
    // By start, not end: portify is single-flight per feature, so the
    // later-started workflow is the later-saved one, and `startedAt` is the field
    // every row is guaranteed to carry.
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.workflowId
}

function portifyEvidence(deps: WorkspaceEvidenceDeps, feature: string, featureDir: string): EvidenceBlock | undefined {
  const workflowId = savedPortifyWorkflowId(deps.logsDir, feature)
  const overlay = readOverlay(featureDir)
  if (!overlay) {
    // A saved workflow OUTRANKS the config here, because the two answer
    // different questions. The workflow holds the double boot and the diff —
    // the proof; the config holds a declaration nothing has tested. The overlay
    // holds neither, so gating the workflow lookup on it (as this did) hid the
    // proof whenever the patch was absent: a no-op port-ification, an overlay
    // the user removed, or edits that landed upstream in the product repo.
    if (workflowId) return { workflowId }
    // No workflow either is still NOT "no evidence". A suite whose start
    // commands already declare a port slot per service is concurrency-ready by
    // construction — portify has nothing to rewrite, so it correctly never ran
    // and correctly leaves no artifact. Reading that as absent left the stage
    // ticked and its panel completely blank. The config is the evidence in that
    // case: how many services take their port from the run.
    const config = loadFeatures(deps.featuresDir).find((c) => c.name === feature)
    const { total, slotted } = startCommandPortSlotCounts(config?.repos)
    return total > 0 && slotted === total ? { declaredInjectable: slotted, serviceCount: total } : undefined
  }
  const edits = overlay.meta.repos.reduce((n, r) => n + (r.touchedFiles?.length ?? 0), 0)
  return workflowId ? { edits, workflowId } : { edits }
}

/** The latest SETTLED test run for this feature. Boots/benchmarks/verifies are
 *  not feature runs, and an active run has no verdict to report yet. */
function latestSettledRun(deps: WorkspaceEvidenceDeps, feature: string): { runId: string; status: string } | undefined {
  const runs = listRuns(deps.logsDir, { feature }).filter(
    (r) =>
      r.executionType !== 'boot' &&
      r.executionType !== 'benchmark' &&
      r.executionType !== 'verify' &&
      (r.status === 'passed' || r.status === 'failed'),
  )
  const latest = runs[0]
  return latest ? { runId: latest.runId, status: latest.status } : undefined
}

function runEvidence(deps: WorkspaceEvidenceDeps, feature: string): EvidenceBlock | undefined {
  const latest = latestSettledRun(deps, feature)
  if (!latest) return undefined
  const runDir = runDirFor(deps.logsDir, latest.runId)
  const counts = runCounts(readRunSummary(runDir))
  return { runId: latest.runId, status: latest.status, ...(counts ? { counts } : {}) }
}

/** The heal half of the run↔heal pair mirrors the run's manifest — it never
 *  re-runs anything, so its evidence is a read of what the run's heal loop did. */
function healEvidence(deps: WorkspaceEvidenceDeps, feature: string): EvidenceBlock | undefined {
  const latest = latestSettledRun(deps, feature)
  if (!latest) return undefined
  const manifest = readManifest(buildRunPaths(runDirFor(deps.logsDir, latest.runId)).manifestPath)
  if (!manifest) return undefined
  return {
    finalStatus: latest.status,
    ...(typeof manifest.healCycles === 'number' ? { healCycles: manifest.healCycles } : {}),
    ...(manifest.healEnd ? { healEnd: manifest.healEnd } : {}),
  }
}

/** The newest completed export archive for this feature, by task recency. Reports
 *  the task ID, not a filesystem path: the client already holds the export tasks
 *  and builds its download from the id, so an absolute server path would be both
 *  redundant and a leak. */
function evaluationExportEvidence(deps: WorkspaceEvidenceDeps, feature: string): EvidenceBlock | undefined {
  const done = listEvaluationExportTasks(deps.logsDir)
    .filter((t) => t.feature === feature && t.status === 'completed' && t.downloadReady)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const task = done[0]
  return task ? { taskId: task.taskId, runId: task.runId, mode: task.mode } : undefined
}

/** The repositories the suite is configured against — the one thing about a repo
 *  scan that IS on disk.
 *
 *  Deliberately not `envFiles`: that is what a scan OBSERVED at the time, and no
 *  artifact records it, so reporting zero would turn "never measured" into
 *  "measured none". The repo list is different — it is a config read, the same
 *  one the Repo scan panel's own tiles already perform. Without it a flight
 *  resumed past this step marked the row ↷ over a fully populated pane.
 *  Deduplicated for the reason `distinctRepoPaths` exists: services sharing one
 *  source tree are one repository. */
function scoutEvidence(deps: WorkspaceEvidenceDeps, feature: string): EvidenceBlock | undefined {
  const config = loadFeatures(deps.featuresDir).find((c) => c.name === feature)
  const paths = new Set(
    (config?.repos ?? [])
      .map((r) => r.localPath)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => p.replace(/[\\/]+$/, '')),
  )
  return paths.size > 0 ? { repos: paths.size } : undefined
}

/** Per-stage probe. `similarity` is deliberately absent: it reports which suites
 *  a scan compared, and no artifact on disk records that. */
const PROBES: Partial<Record<FlightStageKey, (deps: WorkspaceEvidenceDeps, feature: string, featureDir: string, env?: string) => EvidenceBlock | undefined>> = {
  'scout': (deps, feature) => scoutEvidence(deps, feature),
  'env-capture': (deps, feature, featureDir, env) => envCaptureEvidence(deps, feature, featureDir, env),
  'docs': (_d, _f, featureDir) => docsEvidence(featureDir),
  'prd-summary': (_d, _f, featureDir) => prdSummaryEvidence(featureDir),
  'specs-coverage': (deps, feature) => specsCoverageEvidence(deps, feature),
  'portify': (deps, feature, featureDir) => portifyEvidence(deps, feature, featureDir),
  'run': (deps, feature) => runEvidence(deps, feature),
  'heal': (deps, feature) => healEvidence(deps, feature),
  'evaluation-export': (deps, feature) => evaluationExportEvidence(deps, feature),
}

/** Probe the workspace for the named stages only. A probe that throws is
 *  dropped, never propagated: this fills gaps in a read that must still succeed
 *  (a feature whose config no longer loads, a half-written artifact) — the panel
 *  falls back to its status-only rendering exactly as it does today. */
export function workspaceStageEvidence(
  deps: WorkspaceEvidenceDeps,
  feature: string,
  keys: FlightStageKey[],
  env?: string,
): Partial<Record<FlightStageKey, EvidenceBlock>> {
  const wanted = keys.filter((k) => PROBES[k])
  if (wanted.length === 0) return {}
  let featureDir: string
  try {
    featureDir = resolveFeatureDir(deps.featuresDir, feature)
  } catch {
    return {}
  }
  const out: Partial<Record<FlightStageKey, EvidenceBlock>> = {}
  for (const key of wanted) {
    try {
      const block = PROBES[key]!(deps, feature, featureDir, env)
      if (block) out[key] = block
    } catch {
      // Probe failed — leave the stage as it was.
    }
  }
  return out
}

/** True when a stage carries no usable recorded evidence. An empty object counts
 *  as absent: a stage that settled without writing keys is the same "nothing to
 *  render" case as one that never wrote evidence at all. */
export function stageEvidenceMissing(stage: Pick<FlightStage, 'evidence'>): boolean {
  const ev = stage.evidence
  if (ev === undefined || ev === null) return true
  if (typeof ev !== 'object') return false
  return Object.keys(ev as Record<string, unknown>).length === 0
}

/** Which stages of this manifest would be filled — the lazy-probe key list. Only
 *  SETTLED stages qualify: a pending stage has nothing to report, and a running
 *  one is mid-flight (its adapter owns the evidence and is about to write it). */
export function stagesNeedingEvidence(stages: FlightStage[]): FlightStageKey[] {
  return stages
    .filter((s) => (s.status === 'done' || s.status === 'skipped') && stageEvidenceMissing(s))
    .map((s) => s.key)
}

/** Fill the gaps, never overwrite. A stage that recorded its own evidence keeps
 *  it verbatim — the conducted measurement outranks a later re-probe, because
 *  the workspace may have moved on since (more specs authored, a newer run). */
export function fillStageEvidence(
  stages: FlightStage[],
  computed: Partial<Record<FlightStageKey, EvidenceBlock>>,
): FlightStage[] {
  return stages.map((s) => {
    const block = computed[s.key]
    if (!block || !stageEvidenceMissing(s)) return s
    return { ...s, evidence: block, evidenceSource: 'workspace' as const }
  })
}

/** One call for a whole manifest's read path: probe what's missing, fill it.
 *  Returns the same stage array when there is nothing to fill, so an unaffected
 *  read costs one filter and no filesystem work. */
export function withWorkspaceEvidence(
  deps: WorkspaceEvidenceDeps,
  feature: string,
  stages: FlightStage[],
  env?: string,
): FlightStage[] {
  const keys = stagesNeedingEvidence(stages)
  if (keys.length === 0) return stages
  return fillStageEvidence(stages, workspaceStageEvidence(deps, feature, keys, env))
}
