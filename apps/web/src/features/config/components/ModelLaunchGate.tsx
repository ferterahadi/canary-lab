import { Fragment, useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { AgentStagePlans, ModelAgentKind, ModelStageKey, StageModelChoice } from '@/shared/api/client'
import { MODEL_STAGE_LABEL, resolveStageChoice } from '@shared/agent-models'
import { Modal } from '@/shared/ui/atoms'
import { StageChoiceGrid } from './ModelMatrixDialog'
import { agentTitle } from './settings-options'
import { useAgentModelOptions } from './use-agent-model-options'

// The launch gate (2.2.0 model cockpit): the last look at the model plan before
// an expensive spawn, at the three GUI spawn points — flight start, suite run,
// coverage generate — when `askModelsOnLaunch` is armed. It CONFIRMS by default
// (the saved plan as one passive line) and becomes the editor only on Change. One component, mounted transiently by each
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
  config: api.AgentModelsConfig
  onCancel: () => void
  /** Fired with the per-launch override to ride the payload — null = use
   *  defaults (send nothing; the server resolves config itself). */
  onConfirm: (models: AgentStagePlans | null) => void
  /** Label for the confirm action (e.g. "Start flight", "Run suite"). */
  confirmLabel: string
}

/** One resolved default, compactly: "opus · high", "high", or "agent default". */
function choiceLabel(choice: StageModelChoice): string {
  const knobs = [choice.model, choice.effort].filter((v): v is string => v !== null)
  return knobs.length ? knobs.join(' · ') : 'agent default'
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
  config: api.AgentModelsConfig,
  stages: readonly ModelStageKey[],
): Array<{ choice: string; steps: string }> {
  const groups: Array<{ choice: string; labels: string[] }> = []
  for (const stage of stages) {
    const choice = choiceLabel(resolveStageChoice(agent, config, stage, null))
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
  config: api.AgentModelsConfig,
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
  const { modelOptions } = useAgentModelOptions(agent, customize)
  // Editing works on a per-launch copy seeded from the resolved defaults —
  // Project Settings stays untouched either way. Seeding is a function so
  // "Use saved models" can genuinely restore it, not just collapse the view
  // over edits that would come back on the next Change.
  const seedPlans = (): AgentStagePlans => {
    const seeded: AgentStagePlans = {}
    for (const stage of stages) {
      const resolved = resolveStageChoice(agent, config, stage, null)
      if (resolved.model !== null || resolved.effort !== null) seeded[stage] = resolved
    }
    return seeded
  }
  const [plans, setPlans] = useState<AgentStagePlans>(seedPlans)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  // "Don't ask again" writes the Settings master switch back the moment it is
  // toggled — it is a setting, not part of this launch's payload, and writing
  // it on toggle keeps the launch path itself side-effect free. Best-effort:
  // a failed write leaves the gate armed, which only means being asked again.
  useEffect(() => {
    if (!dontAskAgain) return
    api.putProjectConfig({ askModelsOnLaunch: false }).catch(() => {})
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
            className="mr-auto flex items-center gap-2 text-[11px]"
            style={{ color: 'var(--text-muted)' }}
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
          <button type="button" onClick={onCancel} className="cl-button px-3 py-1 text-xs">
            Cancel
          </button>
          <button
            type="button"
            data-testid="gate-confirm"
            onClick={() => onConfirm(customize ? plans : null)}
            className="cl-button px-3 py-1 text-xs"
            style={{
              color: 'var(--accent)',
              border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
              background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        {/* Collapsed, this dialog CONFIRMS a launch; expanded, it IS the editor.
            The two option cards it replaced made a radio pair out of a fact and
            a button — nobody picks "customize", they click it. */}
        {customize ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                This launch only
              </span>
              {/* Restores the saved plan AND returns to the confirmation, which
                  is the same statement said once: nothing here is changing. */}
              <button
                type="button"
                data-testid="gate-use-saved"
                onClick={() => { setPlans(seedPlans()); setCustomize(false) }}
                className="cl-button shrink-0 px-2 py-0.5 text-[11px]"
              >
                Use saved models
              </button>
            </div>
            <StageChoiceGrid
              agent={agent}
              stages={stages}
              plans={plans}
              modelOptions={modelOptions}
              onChange={(stage, choice) => setPlans((prev) => ({ ...prev, [stage]: choice }))}
            />
          </>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                Your saved models
              </span>
              {stages.length > SUMMARY_STEP_THRESHOLD ? (
                <span data-testid="gate-saved-summary" className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  {savedModelsSummary(agent, config, stages)}
                </span>
              ) : (
                <span
                  data-testid="gate-saved-summary"
                  className="grid gap-x-3 gap-y-1 text-[11px]"
                  style={{ gridTemplateColumns: 'minmax(0,1fr) max-content' }}
                >
                  {defaultsByChoice(agent, config, stages).map((group) => (
                    <Fragment key={group.choice}>
                      <span className="min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>{group.steps}</span>
                      <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{group.choice}</span>
                    </Fragment>
                  ))}
                </span>
              )}
            </span>
            <button
              type="button"
              data-testid="gate-change"
              onClick={() => setCustomize(true)}
              className="cl-button shrink-0 px-2 py-0.5 text-[11px]"
            >
              Change
            </button>
          </div>
        )}
        {/* One scope sentence for the whole dialog. "Locked once started" holds
            for a flight, a run and a coverage job alike — the launch noun is
            already in the title. */}
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Locked once started.
        </div>
      </div>
    </Modal>
  )
}
