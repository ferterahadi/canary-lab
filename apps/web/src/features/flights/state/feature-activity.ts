import { useMemo } from 'react'
import type { CoverageJobIndexEntry, DraftRecord, EvaluationExportTask, RunDetail, RunIndexEntry } from '@/shared/api/types'
import type { FlightStageKey, PortifyIndexEntry } from '@/shared/api/client'
import * as api from '@/shared/api/client'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { useEvaluationExports } from '@/features/evaluation'
import { isActivePortify, usePortify } from '@/features/portify'
import { useActiveRuns, useRunDetails } from '@/features/runs'
import { isActiveWizardTask, useWizardDrafts } from '@/features/wizard'

// Per-feature "what is happening right now" — the live signal behind the
// Flight pill. Since the R6/R15/R19 consolidation absorbed the per-feature
// pills (coverage, portify, services, exports, wizards) and R26 absorbed the
// Runs pill, the Flight pill is the one place a feature's live activity
// surfaces — so it must know about runs, portify jobs, authoring drafts,
// evaluation exports (R29), coverage jobs and deployed-env verifications, not
// just flights. This composes the EXISTING WS-fed stores plus the live
// coverage-jobs read (its store publishes `coverage-changed` on every write,
// so the read re-runs without polling); no new channel (cl_live-state-sync).

export type FeatureActivityKind =
  | 'healing' | 'running' | 'verifying' | 'exporting' | 'portifying'
  | 'authoring' | 'condensing' | 'mapping'

export interface FeatureActivity {
  kind: FeatureActivityKind
  /** Handle into the real surface behind the verb — the kind's own id is set;
   *  `exporting` also carries its runId so a flightless export can still route
   *  to the run detail's Evaluation panel. */
  runId?: string
  workflowId?: string
  draftId?: string
  taskId?: string
  jobId?: string
  /** The work is being done by the user's OWN agent (an MCP client), not by a
   *  process this server spawned. Drives the stage's "running in your agent"
   *  card and the flight view's read-only gate — an externally-driven suite
   *  accepts no mutations here beyond abort/discard. */
  external?: boolean
}

/** Which flight stage a standalone activity kind maps onto — so an
 *  activity-only row (no flight record) can still show WHERE in the pipeline
 *  the live job sits (R56), and so clicking it can open the flight view pinned
 *  to that stage. */
export const ACTIVITY_STAGE: Record<FeatureActivityKind, FlightStageKey> = {
  'authoring': 'specs-coverage',
  // Coverage is two phases of one exercise: the summary job distills docs into
  // the PRD summary (the Requirements pair), the mapping job annotates tests —
  // each belongs to the stage whose evidence it writes.
  'condensing': 'prd-summary',
  'mapping': 'specs-coverage',
  'exporting': 'evaluation-export',
  'portifying': 'portify',
  'running': 'run',
  // A deployed-env verification is a run in verify mode — same stage, the run
  // detail carries the verification framing.
  'verifying': 'run',
  // A repair is a later phase of the SAME job, so it belongs to the run stage —
  // clicking a healing row lands where the failures and the heal agent are.
  'healing': 'run',
}

/**
 * Derive the per-feature activity map. One verb per feature; when several
 * jobs overlap the LOUDEST wins: running/healing > exporting > portifying >
 * coverage jobs > authoring — a live test run is the most downstream signal
 * (it's what the user is waiting on), the export narrates the terminal
 * deliverable, portify boots real services, coverage jobs and authoring only
 * write docs/specs. During a flight this naturally narrates the current
 * stage's underlying job (the specs stage shows "authoring", the portify stage
 * "portifying", the run stage "running", the export stage "exporting");
 * standalone jobs surface the same way.
 *
 * The run's own `status` picks between the run verbs, because the chip is
 * the ONLY place a heal surfaces outside the run detail header: collapsing a
 * healing run to "running" left the suites column and the flights picker
 * claiming tests were executing while a repair agent was actually editing the
 * app.
 */
/** How long an EXTERNAL draft may sit silent before it stops counting as live
 *  "authoring". A server-spawned agent dies with the process (boot reconcile
 *  flips it), but an external MCP session has no heartbeat the server can
 *  poll — an abandoned conversation would paint the verb forever. A working
 *  external agent keeps touching the record (update_external_draft_stage),
 *  so an hour of silence reads as abandoned. The draft itself stays listed
 *  and resumable in the wizard panel either way. */
const EXTERNAL_DRAFT_ACTIVITY_TTL_MS = 60 * 60 * 1000

export function deriveFeatureActivity(input: {
  activeRuns: RunIndexEntry[]
  portifyWorkflows: PortifyIndexEntry[]
  drafts: DraftRecord[]
  exportTasks?: EvaluationExportTask[]
  coverageJobs?: CoverageJobIndexEntry[]
  /** Per-run manifests off the runs stream — where a run's `healMode` lives.
   *  The index entry deliberately doesn't mirror it; active runs always have
   *  a live detail (the WS snapshot ships one per active run). */
  runDetails?: Record<string, RunDetail>
  /** Injected in tests; defaults to wall-clock now. */
  nowMs?: number
}): Map<string, FeatureActivity> {
  const map = new Map<string, FeatureActivity>()
  const nowMs = input.nowMs ?? Date.now()
  const externallyStale = (d: DraftRecord): boolean =>
    d.producer === 'external' && nowMs - Date.parse(d.updatedAt) > EXTERNAL_DRAFT_ACTIVITY_TTL_MS
  // Weakest verb first — stronger ones overwrite the same feature key.
  for (const d of input.drafts) {
    const feature = d.featureName?.trim()
    if (feature && isActiveWizardTask(d.status) && !externallyStale(d)) {
      map.set(feature, { kind: 'authoring', draftId: d.draftId, external: d.producer === 'external' })
    }
  }
  // Summary first so a feature with both phases live reads as the LATER one
  // (the chained mapping job) — the summary phase is already done by then.
  for (const j of input.coverageJobs ?? []) {
    if (j.status !== 'running' || j.kind !== 'summary') continue
    map.set(j.feature, { kind: 'condensing', jobId: j.jobId, external: j.producer === 'external' })
  }
  for (const j of input.coverageJobs ?? []) {
    if (j.status !== 'running' || j.kind !== 'coverage') continue
    map.set(j.feature, { kind: 'mapping', jobId: j.jobId, external: j.producer === 'external' })
  }
  for (const w of input.portifyWorkflows) {
    if (isActivePortify(w.status)) {
      map.set(w.feature, { kind: 'portifying', workflowId: w.workflowId, external: w.producer === 'external' })
    }
  }
  for (const t of input.exportTasks ?? []) {
    const feature = t.feature.trim()
    if (feature && t.status === 'running') {
      map.set(feature, { kind: 'exporting', taskId: t.taskId, runId: t.runId, external: t.producer === 'external' })
    }
  }
  for (const r of input.activeRuns) {
    // Boots are not runs (they have the Services pill) and benchmark runs
    // drive the benchmark window — neither is feature activity here. A
    // deployed-env verification IS: it's a run in verify mode, and the suite's
    // one live indicator must light for it like any other run.
    if (r.executionType === 'boot' || r.executionType === 'benchmark') continue
    const kind: FeatureActivityKind = r.executionType === 'verify'
      ? 'verifying'
      : r.status === 'healing' ? 'healing' : 'running'
    map.set(r.feature, {
      kind,
      runId: r.runId,
      external: input.runDetails?.[r.runId]?.manifest.healMode === 'external',
    })
  }
  return map
}

/** Hook form — must be called under Runs/Portify/WizardDraft/EvaluationExport
 *  providers (App owns the one instance and passes the map down; the pill
 *  stays presentational). */
export function useFeatureActivity(): Map<string, FeatureActivity> {
  const { runs } = useActiveRuns()
  const runDetails = useRunDetails()
  const { workflows } = usePortify()
  const { drafts } = useWizardDrafts()
  const { tasks } = useEvaluationExports()
  // The one non-WS-store input: coverage jobs live in a file-backed store whose
  // every write publishes `coverage-changed` (bridgeCoverageJobEvents), and the
  // workspace socket bumps the unscoped `coverage` topic on that event — so
  // this read re-runs on every job transition, MCP-driven ones included.
  const { value: coverageJobs } = useLiveResource<CoverageJobIndexEntry[]>(
    'coverage',
    'all-jobs',
    () => api.listAllCoverageJobs(),
    { cache: 'coverage-jobs' },
  )
  return useMemo(
    () => deriveFeatureActivity({
      activeRuns: runs,
      portifyWorkflows: workflows,
      drafts,
      exportTasks: tasks,
      coverageJobs: coverageJobs ?? undefined,
      runDetails,
    }),
    [runs, workflows, drafts, tasks, coverageJobs, runDetails],
  )
}
