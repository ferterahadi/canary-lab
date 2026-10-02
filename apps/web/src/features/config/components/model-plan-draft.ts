import { useState } from 'react'
import {
  AGENT_DEFAULT_CHOICE,
  recommendedChoice,
  resolveStageChoice,
  stageChoiceValue,
  type AgentModelsConfig,
  type AgentStagePlans,
  type KnownModelOption,
  type ModelAgentKind,
  type ModelStageKey,
  type StageModelChoice,
} from '@shared/agent-models'

// The one draft both model editors work on — the Settings matrix (saved
// defaults) and the launch gate's Change view (this launch only). The draft is
// COMPLETE over the stages it scopes: agent default is a value a row holds, not
// a missing key. That matters for the launch override, where a missing key means
// "use the saved pin" — so a row deliberately set back to agent default has to
// travel as an explicit entry. Saved config keeps its pruned shape instead.

export type ModelPlanDraft = Partial<Record<ModelStageKey, StageModelChoice>>

export function sameChoice(a: StageModelChoice, b: StageModelChoice): boolean {
  return a.model === b.model && a.effort === b.effort
}

/** One choice as display text: "opus · high", "high", or "agent default". */
export function choiceText(choice: StageModelChoice): string {
  return stageChoiceValue(choice) ?? 'agent default'
}

/** A row's choice — every scoped stage is seeded, so the fallback only covers a
 *  stage the caller never scoped. */
export function draftChoice(draft: ModelPlanDraft, stage: ModelStageKey): StageModelChoice {
  return draft[stage] ?? AGENT_DEFAULT_CHOICE
}

/** Every scoped stage resolved against the saved config, the same resolution a
 *  launch with no override gets on the server. */
export function seedDraft(
  agent: ModelAgentKind,
  stages: readonly ModelStageKey[],
  config: AgentModelsConfig,
): ModelPlanDraft {
  return Object.fromEntries(stages.map((stage) => [stage, resolveStageChoice(agent, config, stage, null)]))
}

/** The shipped recommendation for exactly the scoped stages — a run gate resets
 *  its two rows, not the whole flight. */
export function recommendedDraft(
  agent: ModelAgentKind,
  stages: readonly ModelStageKey[],
  modelOptions: readonly KnownModelOption[],
): ModelPlanDraft {
  return Object.fromEntries(stages.map((stage) => [stage, recommendedChoice(agent, stage, modelOptions)]))
}

export function draftDirty(draft: ModelPlanDraft, seed: ModelPlanDraft, stages: readonly ModelStageKey[]): boolean {
  return stages.some((stage) => !sameChoice(draftChoice(draft, stage), draftChoice(seed, stage)))
}

/** Row status: matches the shipped recommendation, sits on agent default, or
 *  deviates (custom — the row offers a reset). */
export function rowState(
  agent: ModelAgentKind,
  stage: ModelStageKey,
  choice: StageModelChoice,
  modelOptions: readonly KnownModelOption[],
): 'recommended' | 'default' | 'custom' {
  if (sameChoice(choice, recommendedChoice(agent, stage, modelOptions))) return 'recommended'
  if (sameChoice(choice, AGENT_DEFAULT_CHOICE)) return 'default'
  return 'custom'
}

/** The config shape: agent default is the absence of a plan, so the saved block
 *  lists only real pins (mirrors the server's `normalizeStageChoice`). */
export function toSavedPlans(draft: ModelPlanDraft): AgentStagePlans {
  const plans: AgentStagePlans = {}
  for (const [stage, choice] of Object.entries(draft) as Array<[ModelStageKey, StageModelChoice]>) {
    if (!sameChoice(choice, AGENT_DEFAULT_CHOICE)) plans[stage] = choice
  }
  return plans
}

/** The launch payload: null when nothing changed, so the server resolves config
 *  itself; otherwise every scoped stage, agent default included, so an explicit
 *  agent default beats the saved pin. */
export function toLaunchOverride(
  draft: ModelPlanDraft,
  seed: ModelPlanDraft,
  stages: readonly ModelStageKey[],
): AgentStagePlans | null {
  if (!draftDirty(draft, seed, stages)) return null
  return Object.fromEntries(stages.map((stage) => [stage, draftChoice(draft, stage)]))
}

export interface ModelPlanDraftState {
  draft: ModelPlanDraft
  /** The saved plan the draft started from — dirty is measured against it. */
  seed: ModelPlanDraft
  dirty: boolean
  setStage: (stage: ModelStageKey, choice: StageModelChoice) => void
  resetAllToRecommended: (modelOptions: readonly KnownModelOption[]) => void
  restoreSaved: () => void
}

/** The draft and its edits, shared by both editors. The seed is taken once at
 *  mount: both dialogs mount fresh per opening, so a config edit made while one
 *  is open never moves the rows under the user. */
export function useModelPlanDraft(
  agent: ModelAgentKind,
  stages: readonly ModelStageKey[],
  config: AgentModelsConfig,
): ModelPlanDraftState {
  const [seed] = useState(() => seedDraft(agent, stages, config))
  const [draft, setDraft] = useState<ModelPlanDraft>(seed)
  return {
    draft,
    seed,
    dirty: draftDirty(draft, seed, stages),
    setStage: (stage, choice) => setDraft((prev) => ({ ...prev, [stage]: choice })),
    resetAllToRecommended: (modelOptions) => setDraft(recommendedDraft(agent, stages, modelOptions)),
    restoreSaved: () => setDraft(seed),
  }
}
