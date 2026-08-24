import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { FlightStageKey } from '@/shared/api/client'
import type { CoverageJobManifest } from '@/shared/api/types'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { CoverageExternalMonitorPanel } from '@/features/coverage'
import { EvaluationTaskPanel, useEvaluationExports } from '@/features/evaluation'
import { ExternalPortifyPanel, usePortify, usePortifyWorkflow } from '@/features/portify'
import { ExternalDraftAgentPanel } from '@/features/runs'
import { useWizardDrafts } from '@/features/wizard'
import { ACTIVITY_STAGE, type FeatureActivity } from '../state/feature-activity'
import { StageColumn, stageRowKey } from './stage-meta'

// The "handed over to your agent" card, on the stage the work belongs to.
//
// Canary Lab ships two things: skills the user invokes, and the UI to verify
// them. When a skill starts a job from the user's own agent (an external draft,
// coverage job, portify workflow or evaluation export), the flight page is
// where that job is monitored — the same place a conducted flight's stage
// shows its work. Each card is the SAME branded external panel its standalone
// surface renders (cl_reuse-shared-logic): the coverage page's monitor, the
// portify panel, the export task panel, the draft panel the retired draft
// dialog used to host — so an external job reads identically wherever it
// surfaces.
//
// Renders nothing unless the feature's live verb belongs to THIS rail row.
// The run stage is absent deliberately: an external heal already surfaces on
// the Test Run hero / run detail (ExternalHealPanel), and a verify run is
// executed by this server. A flight whose whole pipeline is externally DRIVEN
// (stageProducer external) is also excluded by the caller — its hand-off
// presentation rides the external-work checkpoint, not this card.
export function StageExternalWork({
  activity,
  stageKey,
}: {
  /** This feature's live verb, from the one activity map App derives. */
  activity?: FeatureActivity
  stageKey: FlightStageKey
}) {
  if (!activity || stageRowKey(ACTIVITY_STAGE[activity.kind]) !== stageKey) return null
  // Drafts are always an external agent's work (the GUI wizard is retired), so
  // the authoring card is not gated on the flag the way the others are.
  if (activity.kind === 'authoring' && activity.draftId) {
    return <AuthoringDraftCard draftId={activity.draftId} />
  }
  if (!activity.external) return null
  if ((activity.kind === 'condensing' || activity.kind === 'mapping') && activity.jobId) {
    return <ExternalCoverageJobCard jobId={activity.jobId} />
  }
  if (activity.kind === 'portifying' && activity.workflowId) {
    return <ExternalPortifyCard workflowId={activity.workflowId} />
  }
  if (activity.kind === 'exporting' && activity.taskId) {
    return <ExternalExportCard taskId={activity.taskId} />
  }
  return null
}

/** The live external authoring draft — the panel + cleanup control the routed
 *  draft dialog used to host, now in the one monitoring home (this stage).
 *  Discard is the escape hatch a read-only page keeps: it cancels an in-flight
 *  generation and deletes the record, deciding nothing on the agent's behalf. */
function AuthoringDraftCard({ draftId }: { draftId: string }) {
  const { drafts, deleteTask } = useWizardDrafts()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  // The context's WS-fed list is the source; the card only mounts while the
  // activity map (derived from this same list) says the draft is live, so a
  // missing record is just the frame between delete and unmount.
  const draft = drafts.find((d) => d.draftId === draftId) ?? null
  if (!draft) return null
  const stageView = draft.status === 'planning' ? 'planning' : 'generating'
  return (
    <StageColumn>
      <div data-testid="stage-external-authoring" className="flex flex-col gap-2">
        <div className="flex min-h-6 items-center justify-between gap-2">
          <span className="cl-rubric">Authoring in your agent</span>
          {confirming ? (
            <button
              type="button"
              data-testid="draft-discard-confirm"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                // deleteTask cancels an in-flight generation first, then
                // deletes the record; the WS delete event unmounts this card.
                deleteTask(draftId).finally(() => setBusy(false))
              }}
              className="cl-button px-2.5 py-1 text-xs"
              style={{ color: 'var(--danger)' }}
            >
              {busy ? 'Discarding…' : 'Really discard?'}
            </button>
          ) : (
            <button
              type="button"
              data-testid="draft-discard"
              onClick={() => setConfirming(true)}
              className="cl-button px-2.5 py-1 text-xs"
              title="Stop the authoring agent and delete this draft"
            >
              Discard draft
            </button>
          )}
        </div>
        <ExternalDraftAgentPanel draft={draft} stageView={stageView} />
      </div>
    </StageColumn>
  )
}

/** An external coverage job (summary or mapping) — the same monitor the
 *  coverage page's Generating pane shows. `coverage` is the live trigger: the
 *  job store publishes `coverage-changed` on every write, log appends included,
 *  so the tracked log streams here without polling. */
function ExternalCoverageJobCard({ jobId }: { jobId: string }) {
  const { value: job } = useLiveResource<CoverageJobManifest>(
    'coverage',
    jobId,
    (id) => api.getCoverageJob(id),
  )
  if (!job) return null
  return (
    <StageColumn>
      <div data-testid="stage-external-coverage">
        <CoverageExternalMonitorPanel job={job} />
      </div>
    </StageColumn>
  )
}

/** An external portify workflow — the same panel the Ports tab renders. The
 *  `/ws/portify` store snapshots active workflows, so the manifest is usually
 *  in hand; the one-shot hydrate covers a cold load racing the snapshot. */
function ExternalPortifyCard({ workflowId }: { workflowId: string }) {
  const manifest = usePortifyWorkflow(workflowId)
  const { loadPortify } = usePortify()
  useEffect(() => {
    if (manifest) return
    // loadPortify swallows its own fetch failure; the catch keeps a future
    // rewrite of it from turning a hydrate miss into an unhandled rejection.
    void loadPortify(workflowId).catch(() => {})
  }, [workflowId, manifest, loadPortify])
  if (!manifest) return null
  return (
    <StageColumn>
      <div data-testid="stage-external-portify">
        <ExternalPortifyPanel m={manifest} />
      </div>
    </StageColumn>
  )
}

/** A live external evaluation export — the shared task panel (which renders the
 *  branded external card for external-producer tasks and watches the log
 *  stream). No download button: the stage's deliverable card below owns the
 *  download once the archive lands. */
function ExternalExportCard({ taskId }: { taskId: string }) {
  const { taskById } = useEvaluationExports()
  const task = taskById(taskId)
  if (!task) return null
  return (
    <StageColumn>
      <div data-testid="stage-external-export">
        <EvaluationTaskPanel task={task} showDownload={false} />
      </div>
    </StageColumn>
  )
}
