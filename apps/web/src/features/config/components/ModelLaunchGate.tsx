import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { AgentStagePlans, ModelAgentKind, ModelStageKey, StageModelChoice } from '@/shared/api/client'
import { MODEL_STAGE_LABEL, resolveStageChoice } from '@shared/agent-models'
import { Modal } from '@/shared/ui/atoms'
import { OPTION_ROW_CLASS, optionRowStyle } from '@/shared/ui/OptionRow'
import { StageChoiceGrid } from './ModelMatrixDialog'
import { agentTitle } from './settings-options'

// The launch gate (2.2.0 model cockpit): "use defaults or customize?" asked at
// the three GUI spawn points — flight start, suite run, coverage generate —
// when `askModelsOnLaunch` is armed. One component, mounted transiently by each
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
  /** The saved workspace defaults the cards resolve against. */
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

export function ModelLaunchGate({ launchNoun, agent, stages, config, onCancel, onConfirm, confirmLabel }: ModelLaunchGateProps) {
  const [customize, setCustomize] = useState(false)
  // The customize card edits a per-launch copy seeded from the resolved
  // defaults — Project Settings stays untouched either way.
  const [plans, setPlans] = useState<AgentStagePlans>(() => {
    const seeded: AgentStagePlans = {}
    for (const stage of stages) {
      const resolved = resolveStageChoice(agent, config, stage, null)
      if (resolved.model !== null || resolved.effort !== null) seeded[stage] = resolved
    }
    return seeded
  })
  const [dontAskAgain, setDontAskAgain] = useState(false)

  // "Don't ask again" writes the Settings master switch back the moment it is
  // toggled — it is a setting, not part of this launch's payload, and writing
  // it on toggle keeps the launch path itself side-effect free. Best-effort:
  // a failed write leaves the gate armed, which only means being asked again.
  useEffect(() => {
    if (!dontAskAgain) return
    api.putProjectConfig({ askModelsOnLaunch: false }).catch(() => {})
  }, [dontAskAgain])

  const card = (selected: boolean, onPick: () => void, testId: string, label: string, chip: string, body?: React.ReactNode) => (
    <button
      type="button"
      data-testid={testId}
      onClick={onPick}
      className={`${OPTION_ROW_CLASS} w-full flex-col !items-stretch gap-1.5 rounded-md border ${selected ? '' : 'cl-hover-row'}`}
      style={{ ...optionRowStyle({ selected, interactive: true }), borderColor: selected ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border-default)' }}
    >
      <span className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
        <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}>{chip}</span>
      </span>
      {body}
    </button>
  )

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
          <label className="mr-auto flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              data-testid="gate-dont-ask-again"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              className="h-[13px] w-[13px]"
              style={{ accentColor: 'var(--accent)' }}
            />
            Don&apos;t ask again — use defaults silently (change any time in Project Settings)
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
        {card(!customize, () => setCustomize(false), 'gate-use-defaults', 'Use suite defaults', '✦ from Project Settings', (
          // The resolved plan inline, so "use defaults" is an informed click.
          <span className="flex flex-col gap-0.5">
            {stages.map((stage) => (
              <span key={stage} className="flex items-baseline gap-2 text-[11px]">
                <span style={{ color: 'var(--text-secondary)' }}>{MODEL_STAGE_LABEL[stage]}</span>
                <span className="font-medium" style={{ color: 'var(--text-muted)' }}>
                  {choiceLabel(resolveStageChoice(agent, config, stage, null))}
                </span>
              </span>
            ))}
          </span>
        ))}
        {card(customize, () => setCustomize(true), 'gate-customize', 'Customize for this launch', 'this launch only', (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Pick model and effort per stage below. Project Settings defaults are not changed.
          </span>
        ))}
        {customize && (
          <StageChoiceGrid
            agent={agent}
            stages={stages}
            plans={plans}
            onChange={(stage, choice) => setPlans((prev) => ({ ...prev, [stage]: choice }))}
          />
        )}
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          🔒 Final once started — the plan is persisted on this record and can&apos;t be changed mid-execution.
          Later edits to defaults apply to future launches only.
        </div>
      </div>
    </Modal>
  )
}
