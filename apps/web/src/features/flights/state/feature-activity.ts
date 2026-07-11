import { useMemo } from 'react'
import type { DraftRecord, EvaluationExportTask, RunIndexEntry } from '../../../shared/api/types'
import type { PortifyIndexEntry } from '../../../shared/api/client'
import { useActiveRuns } from '../../runs/state/RunsContext'
import { useEvaluationExports } from '../../evaluation/state/EvaluationExportContext'
import { usePortify } from '../../portify/state/PortifyContext'
import { isActivePortify } from '../../portify/state/portify-state'
import { isActiveWizardTask, useWizardDrafts } from '../../wizard/state/WizardDraftContext'

// Per-feature "what is happening right now" — the live signal behind the
// Flight pill. Since the R6/R15/R19 consolidation absorbed the per-feature
// pills (coverage, portify, services, exports, wizards) and R26 absorbed the
// Runs pill, the Flight pill is the one place a feature's live activity
// surfaces — so it must know about runs, portify jobs, authoring drafts, and
// evaluation exports (R29), not just flights. This composes the four EXISTING
// WS-fed stores; no new channel (cl_live-state-sync): each store already rides
// its own reliable stream, so this is pure derivation.

export type FeatureActivityKind = 'running' | 'exporting' | 'portifying' | 'authoring'

export interface FeatureActivity {
  kind: FeatureActivityKind
  /** Handle into the real surface behind the verb — the kind's own id is set;
   *  `exporting` also carries its runId so a flightless export can still route
   *  to the run detail's Evaluation panel. */
  runId?: string
  workflowId?: string
  draftId?: string
  taskId?: string
}

/**
 * Derive the per-feature activity map. One verb per feature; when several
 * jobs overlap the LOUDEST wins: running > exporting > portifying > authoring —
 * a live test run is the most downstream signal (it's what the user is waiting
 * on), the export narrates the terminal deliverable, portify boots real
 * services, authoring only drafts specs. During a flight this naturally
 * narrates the current stage's underlying job (the specs stage shows
 * "authoring", the portify stage "portifying", the run stage "running", the
 * export stage "exporting"); standalone jobs surface the same way.
 */
export function deriveFeatureActivity(input: {
  activeRuns: RunIndexEntry[]
  portifyWorkflows: PortifyIndexEntry[]
  drafts: DraftRecord[]
  exportTasks?: EvaluationExportTask[]
}): Map<string, FeatureActivity> {
  const map = new Map<string, FeatureActivity>()
  // Weakest verb first — stronger ones overwrite the same feature key.
  for (const d of input.drafts) {
    const feature = d.featureName?.trim()
    if (feature && isActiveWizardTask(d.status)) map.set(feature, { kind: 'authoring', draftId: d.draftId })
  }
  for (const w of input.portifyWorkflows) {
    if (isActivePortify(w.status)) map.set(w.feature, { kind: 'portifying', workflowId: w.workflowId })
  }
  for (const t of input.exportTasks ?? []) {
    const feature = t.feature.trim()
    if (feature && t.status === 'running') map.set(feature, { kind: 'exporting', taskId: t.taskId, runId: t.runId })
  }
  for (const r of input.activeRuns) {
    // Boots are not runs (they have the Services pill), benchmark runs drive
    // the benchmark window, and deployed-env verifications have the Deploy
    // check pill (R27) — none is feature activity here.
    if (r.executionType === 'boot' || r.executionType === 'benchmark' || r.executionType === 'verify') continue
    map.set(r.feature, { kind: 'running', runId: r.runId })
  }
  return map
}

/** Hook form — must be called under Runs/Portify/WizardDraft/EvaluationExport
 *  providers (App owns the one instance and passes the map down; the pill
 *  stays presentational). */
export function useFeatureActivity(): Map<string, FeatureActivity> {
  const { runs } = useActiveRuns()
  const { workflows } = usePortify()
  const { drafts } = useWizardDrafts()
  const { tasks } = useEvaluationExports()
  return useMemo(
    () => deriveFeatureActivity({ activeRuns: runs, portifyWorkflows: workflows, drafts, exportTasks: tasks }),
    [runs, workflows, drafts, tasks],
  )
}
