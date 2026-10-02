import { Fragment, useEffect, useState } from 'react'
import * as agentModelsApi from '@shared/agent-models'
import * as configApi from '@/shared/api/config'
import {
  MODEL_STAGE_LABEL,
  resolveStageChoice,
  type AgentStagePlans,
  type ModelAgentKind,
  type ModelStageKey,
} from '@shared/agent-models'
import { Modal } from '@/shared/ui/Overlays'
import { agentTitle } from './settings-options'
import { ModelPlanEditor } from './ModelPlanEditor'
import { choiceText, toLaunchOverride, useModelPlanDraft } from './model-plan-draft'

// The launch gate (2.2.0 model cockpit): the last look at the model plan before
// an expensive spawn, at the three GUI spawn points — flight start, suite run,
// coverage generate — when `askModelsOnLaunch` is armed. It CONFIRMS by default
// (the saved plan as one passive line) and becomes the editor only on Change —
// the same `ModelPlanEditor` and draft the Settings matrix uses, scoped to this
// launch's stages. One component, mounted transiently by each
// launcher (deliberately unrouted: like the collision prompt it holds
// click-time parameters — env, mode — a cold load cannot reconstruct; the
// flight mount rides the already-routed launcher dialog).

export interface ModelLaunchGateProps {
  /** What this launch spawns — names the dialog ("Models for this flight"). */
  launchNoun: string
  /** The agent whose vocabulary the rows show — the one this launch will run. */
  agent: ModelAgentKind
  /** Only the stages this launch actually spawns (a coverage job shows 2 rows). */
  stages: readonly ModelStageKey[]
  /** The saved workspace defaults this launch resolves against. */
  config: agentModelsApi.AgentModelsConfig
  onCancel: () => void
  /** Fired with the per-launch override to ride the payload — null = use
   *  defaults (send nothing; the server resolves config itself). An override
   *  names every scoped stage, so an explicit agent default beats a saved pin. */
  onConfirm: (models: AgentStagePlans | null) => void
  /** Label for the confirm action (e.g. "Start flight", "Run suite"). */
  confirmLabel: string
}

/** Above this many steps the resolved defaults summarize by model instead of
 *  listing groups: a nine-step flight plan is a paragraph, while a two-step run
 *  gate reads better naming its two steps outright. */
const SUMMARY_STEP_THRESHOLD = 3

/** The resolved defaults GROUPED by the choice the steps share — the reading
 *  for a SHORT plan (a run or coverage gate scopes two steps), where naming the
 *  steps costs one line and answers more than a count would. */
export function defaultsByChoice(
  agent: ModelAgentKind,
  config: agentModelsApi.AgentModelsConfig,
  stages: readonly ModelStageKey[],
): Array<{ choice: string; steps: string }> {
  const groups: Array<{ choice: string; labels: string[] }> = []
  for (const stage of stages) {
    const choice = choiceText(resolveStageChoice(agent, config, stage, null))
    const group = groups.find((g) => g.choice === choice)
    if (group) group.labels.push(MODEL_STAGE_LABEL[stage])
    else groups.push({ choice, labels: [MODEL_STAGE_LABEL[stage]] })
  }
  return groups.map(({ choice, labels }) => ({ choice, steps: labels.join(', ') }))
}

/** A long plan in ONE line: which model does how much of the work. Effort is
 *  deliberately absent — it is a second axis nobody needs before deciding
 *  whether to change anything, and the grid behind Change carries it. */
export function savedModelsSummary(
  agent: ModelAgentKind,
  config: agentModelsApi.AgentModelsConfig,
  stages: readonly ModelStageKey[],
): string {
  const groups: Array<{ model: string; count: number }> = []
  for (const stage of stages) {
    const model = resolveStageChoice(agent, config, stage, null).model ?? 'agent default'
    const group = groups.find((g) => g.model === model)
    if (group) group.count += 1
    else groups.push({ model, count: 1 })
  }
  return groups.map((g) => `${g.model} on ${g.count} step${g.count === 1 ? '' : 's'}`).join(' · ')
}

export function ModelLaunchGate({ launchNoun, agent, stages, config, onCancel, onConfirm, confirmLabel }: ModelLaunchGateProps) {
  const [customize, setCustomize] = useState(false)
  // Editing works on a per-launch draft seeded from the resolved defaults —
  // Project Settings stays untouched either way.
  const plan = useModelPlanDraft(agent, stages, config)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  // "Don't ask again" writes the Settings master switch back the moment it is
  // toggled — it is a setting, not part of this launch's payload, and writing
  // it on toggle keeps the launch path itself side-effect free. Best-effort:
  // a failed write leaves the gate armed, which only means being asked again.
  useEffect(() => {
    if (!dontAskAgain) return
    configApi.putProjectConfig({ askModelsOnLaunch: false }).catch(() => {})
  }, [dontAskAgain])

  return (
    <Modal
      open
      onClose={onCancel}
      title={`Models for this ${launchNoun}`}
      eyebrow={agentTitle(agent)}
      ariaLabel={`Models for this ${launchNoun}`}
      testId="model-launch-gate"
      width={620}
      stableScrollGutter
      footer={
        <>
          {/* The full rule lives in the tooltip: a sentence-long label beside
              two buttons made the footer read as a third paragraph. */}
          <label
            className="cl-type-meta mr-auto flex items-center gap-2 text-muted"
            title="Launches use your saved defaults without asking. Turn it back on any time in Project Settings."
          >
            <input
              type="checkbox"
              data-testid="gate-dont-ask-again"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              className="h-[13px] w-[13px]"
              style={{ accentColor: 'var(--accent)' }}
            />
            Don&apos;t ask again
          </label>
          <button type="button" onClick={onCancel} className="cl-button px-3 py-1">
            Cancel
          </button>
          <button
            type="button"
            data-testid="gate-confirm"
            onClick={() => onConfirm(customize ? toLaunchOverride(plan.draft, plan.seed, stages) : null)}
            className="cl-button-primary px-3.5 py-1"
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="px-4 py-3">
        {/* Collapsed, this dialog CONFIRMS a launch; expanded, it IS the editor
            — the same one Settings shows, so changing models reads the same
            wherever it happens. The summary needs no "Saved models" label:
            the title names the launch, the rows name the models. */}
        {customize ? (
          <ModelPlanEditor
            agent={agent}
            stages={stages}
            plan={plan}
            toolbarExtra={
              // Restores the saved plan AND returns to the confirmation, which
              // is the same statement said once: nothing here is changing.
              <button
                type="button"
                data-testid="gate-use-saved"
                onClick={() => { plan.restoreSaved(); setCustomize(false) }}
                className="cl-icon-button cl-type-meta h-6 shrink-0 px-2"
              >
                Use saved
              </button>
            }
          />
        ) : (
          <div className="flex items-baseline justify-between gap-3 py-1">
            {stages.length > SUMMARY_STEP_THRESHOLD ? (
              <span data-testid="gate-saved-summary" className="cl-type-data min-w-0 text-secondary">
                {savedModelsSummary(agent, config, stages)}
              </span>
            ) : (
              <span
                data-testid="gate-saved-summary"
                className="cl-type-data grid min-w-0 gap-x-3 gap-y-1"
                style={{ gridTemplateColumns: 'minmax(0,1fr) max-content' }}
              >
                {defaultsByChoice(agent, config, stages).map((group) => (
                  <Fragment key={group.choice}>
                    <span className="min-w-0 truncate text-secondary">{group.steps}</span>
                    <span className="font-mono text-muted">{group.choice}</span>
                  </Fragment>
                ))}
              </span>
            )}
            <button
              type="button"
              data-testid="gate-change"
              onClick={() => setCustomize(true)}
              className="cl-icon-button cl-type-meta h-6 shrink-0 px-2"
            >
              Change
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
