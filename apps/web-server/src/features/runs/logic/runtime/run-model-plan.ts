// The run's model+effort plan: which model and reasoning effort the heal REPL
// and the commit-message pass use, resolved ONCE at launch (override → workspace
// `agentModels` config → agent default) and persisted on the manifest — so a
// config edit mid-run cannot change a running agent, and a restart reuses what
// the run started with instead of silently re-resolving.
import {
  normalizeLaunchPlans,
  perAgentStageChoices,
  resolveStageChoice,
  type AgentModelsConfig,
  type StageModelChoice,
} from '../../../../../../../shared/agent-models'
import type { HealAgent } from '../../../agent-sessions/logic/agent-binary'
import type { RunModelPlan } from '../../../../../../../shared/run-manifest'

/** Resolve the plan for a fresh launch. `override` is the untrusted request
 *  body (`models` on POST /api/runs, or a flight's stored stage plan forwarded
 *  by its run stage) — normalized against THIS agent's effort vocabulary before
 *  it can win over config. */
export function resolveRunModelPlan(
  agent: HealAgent,
  config: AgentModelsConfig,
  override?: unknown,
): RunModelPlan {
  const requested = normalizeLaunchPlans(agent, override)
  return {
    heal: resolveStageChoice(agent, config, 'heal', requested.heal ?? null),
    commit: resolveStageChoice(agent, config, 'commit', requested.commit ?? null),
  }
}

/** Restart resolution: the plan is locked to the agent it was resolved for, so
 *  a restart that keeps the same agent reuses the persisted plan verbatim. Only
 *  when the agent changed (the stored CLI vanished and config picked the other
 *  one) — or the record predates plans — does it re-resolve, because the stored
 *  efforts belong to the other CLI's vocabulary. */
export function reuseRunModelPlan(
  agent: HealAgent,
  persisted: { healAgent?: HealAgent; models?: RunModelPlan },
  config: AgentModelsConfig,
): RunModelPlan {
  if (persisted.models && persisted.healAgent === agent) return persisted.models
  return resolveRunModelPlan(agent, config)
}

/** Per-agent commit-message choices for the PR pipeline, which picks its own
 *  CLI by availability at spawn time — so it needs a choice for WHICHEVER it
 *  lands on, each resolved against that agent's own config row. `lock` lays the
 *  run's persisted choice over the matching agent's entry, honoring the
 *  launch-time snapshot when the pass picks the same CLI the run resolved for. */
export function commitModelPlans(
  config: AgentModelsConfig,
  lock?: { agent: HealAgent; choice: StageModelChoice },
): Partial<Record<HealAgent, StageModelChoice>> {
  const plans = perAgentStageChoices(config, 'commit')
  if (lock) plans[lock.agent] = lock.choice
  return plans
}
