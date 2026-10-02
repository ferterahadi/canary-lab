import type { ReactNode } from 'react'
import type { AgentProbeSnapshot } from '@/shared/api/config'
import {
  EFFORT_LEVELS,
  KNOWN_MODEL_OPTIONS,
  MODEL_STAGE_LABEL,
  STAGE_RECOMMENDATION_REASON,
  STAGE_TIERS,
  recommendedChoice,
  type KnownModelOption,
  type ModelAgentKind,
  type ModelStageKey,
  type StageModelChoice,
} from '@shared/agent-models'
import { StatusDot } from '@/shared/ui/atoms'
import { Tooltip } from '@/shared/ui/Tooltip'
import { choiceText, draftChoice, rowState, type ModelPlanDraft, type ModelPlanDraftState } from './model-plan-draft'
import { useAgentModelOptions } from './use-agent-model-options'

// The one model editor (2.2.0 model cockpit): the body of the Settings matrix
// (saved defaults) AND of the launch gate's Change view (this launch only). Both
// dialogs pass a draft from `useModelPlanDraft` and differ only in what their
// primary action does with it, so the probe line, the rows, the marks and the
// Reset all action can never drift into two looks again.

/** The select sentinel for "a model id the curated list doesn't know" — picking
 *  it reveals the free-text id input (the escape hatch for new releases). */
const CUSTOM = '__custom'

/** One grid template for the column rubrics and every row, so they align. */
const ROW_COLUMNS = 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) 24px'

const SELECT_CLASS = 'themed-select cl-input cl-type-data w-full py-1 pl-2 pr-7'

function ProbeLine({ agent, probe, busy, onRetry }: {
  agent: ModelAgentKind
  probe: AgentProbeSnapshot | null
  busy: boolean
  onRetry: () => void
}) {
  const entry = probe?.[agent] ?? null
  const retry = (
    <button type="button" onClick={onRetry} disabled={busy} className="cl-button shrink-0 px-2 py-0.5">
      {busy ? 'Probing…' : 'Retry probe'}
    </button>
  )
  // Still probing (or the request itself failed): stay quiet — the probe is
  // informational and must never block configuring.
  if (!entry) {
    return (
      <div className="cl-type-meta flex items-center gap-2 text-muted">
        <span className="min-w-0 flex-1 truncate">{busy ? 'Checking the installed CLI…' : 'CLI check unavailable — settings still apply.'}</span>
        {!busy && retry}
      </div>
    )
  }
  if (entry.state === 'ok') {
    return (
      <div className="cl-type-meta flex items-center gap-2 text-muted">
        <StatusDot state="success" />
        <span className="min-w-0 flex-1 truncate" title={entry.binaryPath ?? undefined}>
          {agent} CLI found{entry.version ? ` — ${entry.version}` : ''}
        </span>
      </div>
    )
  }
  // auth / missing: a warning dot and the exact remedy, never a tinted slab —
  // and nothing disabled, since agent default keeps every launch possible.
  return (
    <div data-testid="model-matrix-probe-warning" className="cl-type-meta flex items-start gap-2 text-secondary">
      <StatusDot state="warning" className="mt-[3px] shrink-0" />
      <span className="min-w-0 flex-1">
        {entry.state === 'missing' ? `The ${agent} CLI isn't on PATH.` : `The ${agent} CLI needs a sign-in.`}
        {entry.remedy ? ` ${entry.remedy}` : ''}
        {' '}Choices here still save and apply once the CLI works.
      </span>
      {retry}
    </div>
  )
}

/** The trailing mark: a quiet ✦ when the row matches the recommendation, a reset
 *  when it deviates, nothing on agent default. Shapes, not worded chips — the
 *  tooltip names the mark, and the aria-label carries it for a screen reader. */
function RowMark({ agent, stage, choice, modelOptions, onChange }: {
  agent: ModelAgentKind
  stage: ModelStageKey
  choice: StageModelChoice
  modelOptions: readonly KnownModelOption[]
  onChange: (stage: ModelStageKey, choice: StageModelChoice) => void
}) {
  const state = rowState(agent, stage, choice, modelOptions)
  if (state === 'default') return null
  const recommendation = recommendedChoice(agent, stage, modelOptions)
  if (state === 'recommended') {
    const label = `Recommended (${STAGE_TIERS[stage]}). ${STAGE_RECOMMENDATION_REASON[stage]}`
    return (
      <Tooltip label={label}>
        <span role="img" aria-label={label} data-mark="recommended" className="cl-type-data text-center text-muted">✦</span>
      </Tooltip>
    )
  }
  return (
    <Tooltip label={`Differs from recommended (${choiceText(recommendation)}). Reset`}>
      <button
        type="button"
        aria-label={`Reset ${MODEL_STAGE_LABEL[stage]} to recommended`}
        data-mark="custom"
        onClick={() => onChange(stage, recommendation)}
        className="cl-icon-button h-6 w-6"
      >
        ↺
      </button>
    </Tooltip>
  )
}

/** The per-stage model + effort rows. Controlled: the caller owns the draft. */
export function StageChoiceGrid({ agent, stages, draft, modelOptions, onChange }: {
  agent: ModelAgentKind
  stages: readonly ModelStageKey[]
  draft: ModelPlanDraft
  /** Runtime-discovered options when available; omitted means the curated
   *  fallback, which always retains Agent default + Custom id. */
  modelOptions?: readonly KnownModelOption[]
  onChange: (stage: ModelStageKey, choice: StageModelChoice) => void
}) {
  const efforts = EFFORT_LEVELS[agent]
  const knownModelOptions = modelOptions ?? KNOWN_MODEL_OPTIONS[agent]
  const knownModels = new Set(knownModelOptions.map(({ value }) => value))
  return (
    <div className="cl-ledger">
      <div className="grid items-center gap-2 py-1.5" style={{ gridTemplateColumns: ROW_COLUMNS }}>
        <span className="cl-rubric">Stage</span>
        <span className="cl-rubric">Model</span>
        <span className="cl-rubric">Reasoning effort</span>
        <span />
      </div>
      {stages.map((stage) => {
        const choice = draftChoice(draft, stage)
        const isCustomModel = choice.model !== null && !knownModels.has(choice.model)
        return (
          <div
            key={stage}
            data-testid={`model-row-${stage}`}
            className="grid items-center gap-2 py-1.5"
            style={{ gridTemplateColumns: ROW_COLUMNS }}
          >
            <span className="cl-type-data min-w-0 truncate text-primary">{MODEL_STAGE_LABEL[stage]}</span>
            <span className="flex min-w-0 flex-col gap-1">
              <select
                aria-label={`${MODEL_STAGE_LABEL[stage]} model`}
                className={SELECT_CLASS}
                value={isCustomModel ? CUSTOM : choice.model ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  // Picking Custom… keeps the current id when there is one
                  // (a known id becomes the editable seed) — never blanks a
                  // value the user typed.
                  onChange(stage, { ...choice, model: v === '' ? null : v === CUSTOM ? choice.model ?? '' : v })
                }}
              >
                <option value="">Agent default</option>
                {knownModelOptions.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
                <option value={CUSTOM}>Custom id…</option>
              </select>
              {isCustomModel && (
                <input
                  aria-label={`${MODEL_STAGE_LABEL[stage]} custom model id`}
                  className="cl-input cl-type-data w-full px-2 py-1"
                  placeholder="model id (passed to --model verbatim)"
                  value={choice.model ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    // Emptying the id falls back to agent default rather
                    // than saving a blank pin.
                    onChange(stage, { ...choice, model: v.trim() ? v : null })
                  }}
                />
              )}
            </span>
            <select
              aria-label={`${MODEL_STAGE_LABEL[stage]} reasoning effort`}
              className={SELECT_CLASS}
              value={choice.effort ?? ''}
              onChange={(e) => onChange(stage, { ...choice, effort: e.target.value || null })}
            >
              <option value="">Agent default</option>
              {efforts.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
            <span className="flex items-center justify-end">
              <RowMark agent={agent} stage={stage} choice={choice} modelOptions={knownModelOptions} onChange={onChange} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** The whole editing body: probe line, the named toolbar with Reset all, the
 *  rows, and the one sentence on what agent default means. */
export function ModelPlanEditor({ agent, stages, plan, label, toolbarExtra }: {
  agent: ModelAgentKind
  stages: readonly ModelStageKey[]
  plan: ModelPlanDraftState
  /** Names what the rows are — "Workspace defaults" or "This launch only". */
  label: string
  /** Actions only one caller has, set before Reset all (the gate's
   *  Use saved models). */
  toolbarExtra?: ReactNode
}) {
  const { probe, probeBusy, retryProbe, modelOptions } = useAgentModelOptions(agent)
  return (
    <div className="flex flex-col gap-3">
      <ProbeLine agent={agent} probe={probe} busy={probeBusy} onRetry={retryProbe} />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="cl-rubric-strong mr-auto">{label}</span>
          {toolbarExtra}
          <button
            type="button"
            data-testid="model-plan-reset-all"
            onClick={() => plan.resetAllToRecommended(modelOptions)}
            className="cl-button shrink-0 px-2 py-0.5"
          >
            Reset all to recommended
          </button>
        </div>
        <StageChoiceGrid agent={agent} stages={stages} draft={plan.draft} modelOptions={modelOptions} onChange={plan.setStage} />
      </div>
      <p className="cl-type-meta text-muted">
        Agent default passes no flags — the CLI runs on its own configuration. ✦ marks the shipped recommendation.
      </p>
    </div>
  )
}
