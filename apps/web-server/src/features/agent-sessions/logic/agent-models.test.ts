import { describe, it, expect } from 'vitest'
import {
  AGENT_DEFAULT_CHOICE,
  EFFORT_LEVELS,
  HEAL_MODELS,
  KNOWN_MODELS,
  MODEL_STAGE_KEYS,
  RECOMMENDED_BY_TIER,
  STAGE_TIERS,
  agentModelArgs,
  effortArgs,
  healModelsFromEnv,
  modelArgs,
  normalizeAgentModels,
  normalizePerAgentChoices,
  normalizeStageChoice,
  perAgentStageChoices,
  pinnedPlanEntries,
  pinnedPlanSummary,
  recommendedChoice,
  resolveStageChoice,
} from './agent-models'

describe('modelArgs', () => {
  it('returns ["--model", id] when a model string is provided', () => {
    expect(modelArgs('claude-opus-4')).toEqual(['--model', 'claude-opus-4'])
  })

  it('returns [] when model is null (agent default)', () => {
    expect(modelArgs(null)).toEqual([])
  })
})

describe('effortArgs', () => {
  it('maps to each CLI\'s own knob: claude --effort, codex -c config override', () => {
    expect(effortArgs('claude', 'high')).toEqual(['--effort', 'high'])
    expect(effortArgs('codex', 'xhigh')).toEqual(['-c', 'model_reasoning_effort=xhigh'])
  })

  it('returns [] for agent default (null effort)', () => {
    expect(effortArgs('claude', null)).toEqual([])
    expect(effortArgs('codex', null)).toEqual([])
  })
})

describe('agentModelArgs', () => {
  it('splices model then effort, dropping whichever half is agent-default', () => {
    expect(agentModelArgs('claude', { model: 'opus', effort: 'high' }))
      .toEqual(['--model', 'opus', '--effort', 'high'])
    expect(agentModelArgs('claude', { model: 'opus', effort: null })).toEqual(['--model', 'opus'])
    expect(agentModelArgs('codex', { model: null, effort: 'medium' }))
      .toEqual(['-c', 'model_reasoning_effort=medium'])
    expect(agentModelArgs('codex', AGENT_DEFAULT_CHOICE)).toEqual([])
  })
})

describe('normalizeStageChoice', () => {
  it('accepts a model string and a valid effort for that agent', () => {
    expect(normalizeStageChoice('claude', { model: 'opus', effort: 'max' }))
      .toEqual({ model: 'opus', effort: 'max' })
  })

  it('drops an effort from the wrong CLI\'s vocabulary but keeps the model', () => {
    // `minimal` exists on codex only; a claude entry carrying it degrades to
    // model-only instead of failing the whole plan.
    expect(normalizeStageChoice('claude', { model: 'opus', effort: 'minimal' }))
      .toEqual({ model: 'opus', effort: null })
    expect(normalizeStageChoice('codex', { model: null, effort: 'minimal' }))
      .toEqual({ model: null, effort: 'minimal' })
  })

  it('trims model whitespace and treats blank as agent default', () => {
    expect(normalizeStageChoice('claude', { model: '  opus  ', effort: null }))
      .toEqual({ model: 'opus', effort: null })
    expect(normalizeStageChoice('claude', { model: '   ', effort: 'high' }))
      .toEqual({ model: null, effort: 'high' })
  })

  it('returns undefined for non-objects and for entries that carry nothing', () => {
    expect(normalizeStageChoice('claude', 'opus')).toBeUndefined()
    expect(normalizeStageChoice('claude', null)).toBeUndefined()
    expect(normalizeStageChoice('claude', { model: null, effort: null })).toBeUndefined()
    expect(normalizeStageChoice('claude', {})).toBeUndefined()
  })
})

describe('normalizeAgentModels', () => {
  it('keeps valid stage entries and drops unknown stages + empty entries', () => {
    expect(normalizeAgentModels({
      claude: {
        heal: { model: 'opus', effort: 'high' },
        warp: { model: 'opus' },
        docs: { model: null, effort: null },
      },
      codex: { commit: { model: null, effort: 'low' } },
    })).toEqual({
      claude: { heal: { model: 'opus', effort: 'high' } },
      codex: { commit: { model: null, effort: 'low' } },
    })
  })

  it('returns empty plans for junk input at every level', () => {
    expect(normalizeAgentModels(undefined)).toEqual({ claude: {}, codex: {} })
    expect(normalizeAgentModels('nope')).toEqual({ claude: {}, codex: {} })
    expect(normalizeAgentModels({ claude: 'nope', codex: 7 })).toEqual({ claude: {}, codex: {} })
  })
})

describe('resolveStageChoice', () => {
  const config = { claude: { heal: { model: 'opus', effort: 'high' } }, codex: {} }

  it('override beats config beats agent default', () => {
    expect(resolveStageChoice('claude', config, 'heal', { model: 'haiku', effort: 'low' }))
      .toEqual({ model: 'haiku', effort: 'low' })
    expect(resolveStageChoice('claude', config, 'heal')).toEqual({ model: 'opus', effort: 'high' })
    expect(resolveStageChoice('claude', config, 'docs')).toBe(AGENT_DEFAULT_CHOICE)
  })

  it('a null/absent override falls through; an absent config resolves agent default', () => {
    expect(resolveStageChoice('claude', config, 'heal', null)).toEqual({ model: 'opus', effort: 'high' })
    expect(resolveStageChoice('codex', undefined, 'heal')).toBe(AGENT_DEFAULT_CHOICE)
  })
})

describe('recommendation policy', () => {
  it('covers every stage with a tier and every tier with a per-agent choice', () => {
    for (const stage of MODEL_STAGE_KEYS) {
      expect(STAGE_TIERS[stage]).toBeDefined()
      for (const agent of ['claude', 'codex'] as const) {
        const rec = recommendedChoice(agent, stage)
        expect(rec).toBe(RECOMMENDED_BY_TIER[agent][STAGE_TIERS[stage]])
        // A recommended effort must be speakable in that CLI's own vocabulary.
        if (rec.effort !== null) {
          expect(EFFORT_LEVELS[agent]).toContain(rec.effort)
        }
      }
    }
  })

  it('repair-adjacent stages recommend the strongest tier — repair is the product', () => {
    expect(STAGE_TIERS.heal).toBe('strongest')
    expect(STAGE_TIERS.gen).toBe('strongest')
    expect(STAGE_TIERS.portify).toBe('strongest')
  })

  it('codex recommendations are effort-only (no curated model ids exist)', () => {
    expect(KNOWN_MODELS.codex).toEqual([])
    for (const tier of ['strongest', 'balanced', 'fastest'] as const) {
      expect(RECOMMENDED_BY_TIER.codex[tier].model).toBeNull()
    }
  })

  it('claude recommendations name only curated aliases', () => {
    for (const tier of ['strongest', 'balanced', 'fastest'] as const) {
      expect(KNOWN_MODELS.claude).toContain(RECOMMENDED_BY_TIER.claude[tier].model)
    }
  })
})

// Repair is the product, so the default here has to stay the agent's own best
// model. The override exists to demonstrate the loop — the strongest model
// fixes everything in one pass and shows none of the iteration.
describe('healModelsFromEnv', () => {
  it('leaves both agents on their own default when nothing is pinned', () => {
    expect(healModelsFromEnv({})).toEqual({ claude: null, codex: null })
  })

  it('pins both arms when CANARY_LAB_HEAL_MODEL is set — only one runs a given repair', () => {
    expect(healModelsFromEnv({ CANARY_LAB_HEAL_MODEL: 'haiku' })).toEqual({ claude: 'haiku', codex: 'haiku' })
  })

  it('treats a blank value as unset rather than as a model named ""', () => {
    expect(healModelsFromEnv({ CANARY_LAB_HEAL_MODEL: '   ' })).toEqual({ claude: null, codex: null })
  })

  it('HEAL_MODELS is the boot-time read of the same pin', () => {
    expect(HEAL_MODELS).toEqual(healModelsFromEnv())
  })
})

describe('perAgentStageChoices', () => {
  const config = {
    claude: { commit: { model: 'haiku', effort: 'low' } },
    codex: { commit: { model: null, effort: 'minimal' } },
  }

  it('resolves the SAME stage for both agents, each from its own row', () => {
    expect(perAgentStageChoices(config, 'commit')).toEqual({
      claude: { model: 'haiku', effort: 'low' },
      codex: { model: null, effort: 'minimal' },
    })
  })

  it('falls back to the agent default per agent, config absent included', () => {
    expect(perAgentStageChoices(config, 'heal'))
      .toEqual({ claude: AGENT_DEFAULT_CHOICE, codex: AGENT_DEFAULT_CHOICE })
    expect(perAgentStageChoices(undefined, 'commit'))
      .toEqual({ claude: AGENT_DEFAULT_CHOICE, codex: AGENT_DEFAULT_CHOICE })
  })
})

describe('normalizePerAgentChoices', () => {
  it('validates each entry against its OWN agent\'s effort vocabulary', () => {
    expect(normalizePerAgentChoices({
      claude: { model: 'opus', effort: 'max' },
      codex: { model: null, effort: 'minimal' },
    })).toEqual({
      claude: { model: 'opus', effort: 'max' },
      codex: { model: null, effort: 'minimal' },
    })
    // `max` is claude-only: the codex entry degrades to nothing and is dropped.
    expect(normalizePerAgentChoices({ codex: { model: null, effort: 'max' } })).toEqual({})
  })

  it('drops empty entries, unknown agents, and junk input wholesale', () => {
    expect(normalizePerAgentChoices({ claude: { model: null, effort: null }, gemini: { model: 'x', effort: 'low' } })).toEqual({})
    expect(normalizePerAgentChoices(undefined)).toEqual({})
    expect(normalizePerAgentChoices('nope')).toEqual({})
    expect(normalizePerAgentChoices(null)).toEqual({})
  })
})

describe('pinned-plan display', () => {
  it('lists pinned stages in stage order with their non-null knobs', () => {
    expect(pinnedPlanEntries({
      commit: { model: 'haiku', effort: null },
      heal: { model: 'opus', effort: 'high' },
      report: { model: null, effort: 'low' },
    })).toEqual([
      'Auto-repair opus · high',
      'Report low',
      'Commit message haiku',
    ])
  })

  it('skips entries that carry nothing so display matches storage semantics', () => {
    expect(pinnedPlanEntries({ heal: { model: null, effort: null } })).toEqual([])
    expect(pinnedPlanEntries({})).toEqual([])
    expect(pinnedPlanEntries(undefined)).toEqual([])
  })

  it('pinnedPlanSummary joins the entries and is null when nothing is pinned', () => {
    expect(pinnedPlanSummary({ heal: { model: 'opus', effort: 'high' } })).toBe('Auto-repair opus · high')
    expect(pinnedPlanSummary({})).toBeNull()
    expect(pinnedPlanSummary(undefined)).toBeNull()
  })
})
