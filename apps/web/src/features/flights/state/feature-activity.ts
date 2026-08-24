import { useMemo } from 'react'
import type { CoverageJobIndexEntry, DraftRecord, EvaluationExportTask, RunDetail, RunIndexEntry } from '@/shared/api/types'
import type { FlightStageKey, PortifyIndexEntry, PortifyManifest } from '@/shared/api/client'
import * as api from '@/shared/api/client'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { useEvaluationExports } from '@/features/evaluation'
import { isActivePortify, usePortify } from '@/features/portify'
import { useActiveRuns, useRunDetails, useRuns } from '@/features/runs'
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
   *  process this server spawned. Drives the stage's compact external-session
   *  Activity row and the flight view's mutation lock. */
  external?: boolean
}

/** Persistent provenance for the newest piece of work behind one Flight step.
 *  Live activity is deliberately separate: a completed external task must stop
 *  lighting the Flights pill, but its Activity rail must not revert to "nothing
 *  ran here" after the files land. */
export interface ExternalWorkTrace {
  kind: FeatureActivityKind
  stage: FlightStageKey
  /** Stable handle into the task's own live/detail store. */
  resourceId?: string
  status: 'running' | 'ready' | 'done' | 'failed' | 'aborted'
  startedAt: string
  updatedAt: string
  clientKind?: string
  sessionId?: string
  conversationName?: string
  sessionUrl?: string
  itemCount?: number
}

export type FeatureExternalHistory = Map<string, Partial<Record<FlightStageKey, ExternalWorkTrace>>>

export interface FeatureWorkState {
  activity: Map<string, FeatureActivity>
  externalHistory: FeatureExternalHistory
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
  /** Per-run manifests off the runs stream. They carry the external client
   *  details for active runs; the compact index mirrors `healMode` so terminal
   *  external provenance also survives a cold load. */
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
      external: r.healMode === 'external' || input.runDetails?.[r.runId]?.manifest.healMode === 'external',
    })
  }
  return map
}

/** Keep only the newest producer for each feature + stage. This matters as
 *  much as keeping terminal records: a stale external run must not keep
 *  claiming the Activity rail after a newer internal run superseded it. */
export function deriveFeatureExternalHistory(input: {
  runs: RunIndexEntry[]
  portifyWorkflows: PortifyIndexEntry[]
  draftRecords: DraftRecord[]
  exportTasks?: EvaluationExportTask[]
  coverageJobs?: CoverageJobIndexEntry[]
  runDetails?: Record<string, RunDetail>
  portifyDetails?: Record<string, PortifyManifest>
}): FeatureExternalHistory {
  type Candidate = ExternalWorkTrace & { external: boolean }
  const latest = new Map<string, Candidate>()

  const remember = (featureValue: string | undefined, candidate: Candidate): void => {
    const feature = featureValue?.trim()
    if (!feature) return
    const key = `${feature}\u0000${candidate.stage}`
    const previous = latest.get(key)
    if (!previous || previous.updatedAt <= candidate.updatedAt) latest.set(key, candidate)
  }

  for (const draft of input.draftRecords) {
    remember(draft.featureName, {
      kind: 'authoring',
      stage: 'specs-coverage',
      resourceId: draft.draftId,
      status: draftTraceStatus(draft.status),
      startedAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      external: draft.producer === 'external',
      ...(draft.externalClientKind ? { clientKind: draft.externalClientKind } : {}),
      ...(draft.externalSessionId ? { sessionId: draft.externalSessionId } : {}),
      ...(draft.externalConversationName ? { conversationName: draft.externalConversationName } : {}),
      ...(draft.externalSessionUrl ? { sessionUrl: draft.externalSessionUrl } : {}),
      ...(draft.generatedFiles ? { itemCount: draft.generatedFiles.length } : {}),
    })
  }

  for (const job of input.coverageJobs ?? []) {
    remember(job.feature, {
      kind: job.kind === 'summary' ? 'condensing' : 'mapping',
      stage: job.kind === 'summary' ? 'prd-summary' : 'specs-coverage',
      resourceId: job.jobId,
      status: backgroundTraceStatus(job.status),
      startedAt: job.startedAt,
      updatedAt: job.endedAt ?? job.startedAt,
      external: job.producer === 'external',
      ...(job.externalClientKind ? { clientKind: job.externalClientKind } : {}),
      ...(job.externalSessionId ? { sessionId: job.externalSessionId } : {}),
      ...(job.externalConversationName ? { conversationName: job.externalConversationName } : {}),
      ...(job.externalSessionUrl ? { sessionUrl: job.externalSessionUrl } : {}),
    })
  }

  for (const workflow of input.portifyWorkflows) {
    const detail = input.portifyDetails?.[workflow.workflowId]
    remember(workflow.feature, {
      kind: 'portifying',
      stage: 'portify',
      resourceId: workflow.workflowId,
      status: portifyTraceStatus(workflow.status),
      startedAt: workflow.startedAt,
      updatedAt: workflow.endedAt ?? workflow.startedAt,
      external: workflow.producer === 'external',
      ...(detail?.external?.clientKind ? { clientKind: detail.external.clientKind } : {}),
      ...(detail?.external?.sessionId ? { sessionId: detail.external.sessionId } : {}),
      ...(detail?.external?.conversationName ? { conversationName: detail.external.conversationName } : {}),
      ...(detail?.external?.sessionUrl ? { sessionUrl: detail.external.sessionUrl } : {}),
    })
  }

  for (const task of input.exportTasks ?? []) {
    remember(task.feature, {
      kind: 'exporting',
      stage: 'evaluation-export',
      resourceId: task.taskId,
      status: task.status === 'running' ? 'running' : task.status === 'completed' ? 'done' : 'failed',
      startedAt: task.createdAt,
      updatedAt: task.updatedAt ?? task.createdAt,
      external: task.producer === 'external',
      ...(task.clientKind ? { clientKind: task.clientKind } : {}),
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(task.conversationName ? { conversationName: task.conversationName } : {}),
      ...(task.externalSessionUrl ? { sessionUrl: task.externalSessionUrl } : {}),
    })
  }

  for (const run of input.runs) {
    if (run.executionType === 'boot' || run.executionType === 'benchmark') continue
    const detail = input.runDetails?.[run.runId]
    remember(run.feature, {
      kind: run.executionType === 'verify'
        ? 'verifying'
        : run.status === 'healing' ? 'healing' : 'running',
      stage: 'run',
      resourceId: run.runId,
      status: runTraceStatus(run.status),
      startedAt: run.startedAt,
      updatedAt: run.endedAt ?? detail?.manifest.endedAt ?? run.startedAt,
      external: run.healMode === 'external' || detail?.manifest.healMode === 'external',
      ...(detail?.manifest.externalHealSession?.clientKind
        ? { clientKind: detail.manifest.externalHealSession.clientKind }
        : {}),
      ...(detail?.manifest.externalHealSession?.sessionId
        ? { sessionId: detail.manifest.externalHealSession.sessionId }
        : {}),
      ...(detail?.manifest.externalHealSession?.conversationName
        ? { conversationName: detail.manifest.externalHealSession.conversationName }
        : {}),
      ...(detail?.manifest.externalHealSession?.sessionUrl
        ? { sessionUrl: detail.manifest.externalHealSession.sessionUrl }
        : {}),
    })
  }

  const history: FeatureExternalHistory = new Map()
  for (const [key, candidate] of latest) {
    if (!candidate.external) continue
    const separator = key.indexOf('\u0000')
    const feature = key.slice(0, separator)
    const stages = history.get(feature) ?? {}
    const { external: _external, ...trace } = candidate
    stages[trace.stage] = trace
    history.set(feature, stages)
  }
  return history
}

function draftTraceStatus(status: DraftRecord['status']): ExternalWorkTrace['status'] {
  if (status === 'planning' || status === 'generating') return 'running'
  if (status === 'accepted') return 'done'
  if (status === 'error') return 'failed'
  if (status === 'cancelled' || status === 'rejected') return 'aborted'
  return 'ready'
}

function backgroundTraceStatus(status: CoverageJobIndexEntry['status']): ExternalWorkTrace['status'] {
  if (status === 'running') return 'running'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  return 'aborted'
}

function portifyTraceStatus(status: PortifyIndexEntry['status']): ExternalWorkTrace['status'] {
  if (status === 'saved') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'aborted') return 'aborted'
  if (status === 'ready-to-save') return 'ready'
  return 'running'
}

function runTraceStatus(status: RunIndexEntry['status']): ExternalWorkTrace['status'] {
  if (status === 'passed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'aborted') return 'aborted'
  return 'running'
}

/** Hook form — must be called under Runs/Portify/WizardDraft/EvaluationExport
 *  providers (App owns the one instance and passes the map down; the pill
 *  stays presentational). */
export function useFeatureWorkState(): FeatureWorkState {
  const { runs } = useActiveRuns()
  const { runs: allRuns } = useRuns()
  const runDetails = useRunDetails()
  const { workflows, details: portifyDetails } = usePortify()
  const { drafts, records } = useWizardDrafts()
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
  return useMemo(() => ({
    activity: deriveFeatureActivity({
      activeRuns: runs,
      portifyWorkflows: workflows,
      drafts,
      exportTasks: tasks,
      coverageJobs: coverageJobs ?? undefined,
      runDetails,
    }),
    externalHistory: deriveFeatureExternalHistory({
      runs: allRuns,
      portifyWorkflows: workflows,
      draftRecords: records ?? drafts,
      exportTasks: tasks,
      coverageJobs: coverageJobs ?? undefined,
      runDetails,
      portifyDetails,
    }),
  }), [allRuns, runs, workflows, portifyDetails, drafts, records, tasks, coverageJobs, runDetails])
}

/** Compatibility hook for consumers that only need the live verb map. New
 *  Flight surfaces should use `useFeatureWorkState` so activity and provenance
 *  come from one snapshot of the shared stores. */
export function useFeatureActivity(): Map<string, FeatureActivity> {
  return useFeatureWorkState().activity
}
