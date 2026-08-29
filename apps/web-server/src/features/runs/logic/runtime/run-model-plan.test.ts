import { describe, expect, it } from 'vitest'
import { commitModelPlans, resolveRunModelPlan, reuseRunModelPlan } from './run-model-plan'
import { EMPTY_AGENT_MODELS, type AgentModelsConfig } from '../../../agent-sessions/logic/agent-models'

const config: AgentModelsConfig = {
  claude: {
    heal: { model: 'opus', effort: 'high' },
    commit: { model: 'haiku', effort: 'low' },
  },
  codex: {
    heal: { model: null, effort: 'xhigh' },
  },
}

describe('resolveRunModelPlan', () => {
  it('falls back to config, then agent default, per stage', () => {
    expect(resolveRunModelPlan('claude', config)).toEqual({
      heal: { model: 'opus', effort: 'high' },
      commit: { model: 'haiku', effort: 'low' },
    })
    // codex config has no commit row → agent default for that half only.
    expect(resolveRunModelPlan('codex', config)).toEqual({
      heal: { model: null, effort: 'xhigh' },
      commit: { model: null, effort: null },
    })
    expect(resolveRunModelPlan('claude', EMPTY_AGENT_MODELS)).toEqual({
      heal: { model: null, effort: null },
      commit: { model: null, effort: null },
    })
  })

  it('lets a normalized override win over config', () => {
    const plan = resolveRunModelPlan('claude', config, {
      heal: { model: 'sonnet', effort: 'medium' },
    })
    expect(plan.heal).toEqual({ model: 'sonnet', effort: 'medium' })
    // The override named only heal — commit still resolves from config.
    expect(plan.commit).toEqual({ model: 'haiku', effort: 'low' })
  })

  it('degrades a junk override to config instead of failing the launch', () => {
    expect(resolveRunModelPlan('claude', config, 'not-a-plan')).toEqual(
      resolveRunModelPlan('claude', config),
    )
    // 'minimal' is codex vocabulary: normalization drops it for claude, and
    // with the model half also empty the whole choice vanishes → config wins.
    expect(
      resolveRunModelPlan('claude', config, { heal: { model: null, effort: 'minimal' } }).heal,
    ).toEqual({ model: 'opus', effort: 'high' })
  })
})

describe('reuseRunModelPlan', () => {
  const persisted = {
    healAgent: 'claude' as const,
    models: { heal: { model: 'opus', effort: 'max' as const }, commit: { model: null, effort: null } },
  }

  it('returns the persisted plan verbatim when the agent is unchanged', () => {
    expect(reuseRunModelPlan('claude', persisted, EMPTY_AGENT_MODELS)).toBe(persisted.models)
  })

  it('re-resolves when the agent changed — the stored efforts belong to the other CLI', () => {
    expect(reuseRunModelPlan('codex', persisted, config)).toEqual({
      heal: { model: null, effort: 'xhigh' },
      commit: { model: null, effort: null },
    })
  })

  it('re-resolves for a pre-2.2.0 record with no plan at all', () => {
    expect(reuseRunModelPlan('claude', { healAgent: 'claude' }, config)).toEqual({
      heal: { model: 'opus', effort: 'high' },
      commit: { model: 'haiku', effort: 'low' },
    })
  })
})

describe('commitModelPlans', () => {
  it('resolves the commit stage per agent from config', () => {
    expect(commitModelPlans(config)).toEqual({
      claude: { model: 'haiku', effort: 'low' },
      codex: { model: null, effort: null },
    })
  })

  it('lays the run lock over the matching agent only', () => {
    const plans = commitModelPlans(config, {
      agent: 'claude',
      choice: { model: 'sonnet', effort: 'medium' },
    })
    expect(plans.claude).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(plans.codex).toEqual({ model: null, effort: null })
  })
})
