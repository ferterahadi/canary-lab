import { describe, expect, it } from 'vitest'
import {
  KNOWN_MODELS,
  MODEL_STAGE_KEYS,
  RECOMMENDED_BY_STAGE,
  normalizeLaunchPlans,
  normalizeStagePlans,
  recommendedChoice,
} from './agent-models.ts'

describe('KNOWN_MODELS', () => {
  it('derives the recognized Claude ids from the curated dropdown options', () => {
    expect(KNOWN_MODELS.claude).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})

describe('RECOMMENDED_BY_STAGE', () => {
  // The Codex column mirrors Claude's: Opus high → Sol high, Sonnet high →
  // Luna max, Sonnet medium → Luna high.
  const CODEX_EFFORT = { opus: 'high', sonnetHigh: 'max', sonnetMedium: 'high' } as const
  const codexEffort = (stage: (typeof MODEL_STAGE_KEYS)[number]) => {
    const claude = RECOMMENDED_BY_STAGE.claude[stage]
    if (claude.model === 'opus') return CODEX_EFFORT.opus
    return claude.effort === 'medium' ? CODEX_EFFORT.sonnetMedium : CODEX_EFFORT.sonnetHigh
  }

  it('prefers GPT-6.1 Sol over older Sol models regardless of catalog order', () => {
    const models = [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    ]
    for (const catalog of [models, [...models].reverse()]) {
      for (const stage of MODEL_STAGE_KEYS) {
        expect(recommendedChoice('codex', stage, catalog)).toEqual({ model: 'gpt-6.1-sol', effort: codexEffort(stage) })
      }
    }
  })

  it('pairs Opus stages with GPT-6.1 Sol and Sonnet stages with GPT-6 Luna', () => {
    const available = [
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
    ]
    expect(Object.fromEntries(MODEL_STAGE_KEYS.map((stage) => [stage, recommendedChoice('codex', stage, available)])))
      .toEqual({
        scout: { model: 'gpt-6-luna', effort: 'max' },
        docs: { model: 'gpt-6-luna', effort: 'max' },
        prd: { model: 'gpt-6.1-sol', effort: 'high' },
        gen: { model: 'gpt-6.1-sol', effort: 'high' },
        mapping: { model: 'gpt-6.1-sol', effort: 'high' },
        heal: { model: 'gpt-6.1-sol', effort: 'high' },
        portify: { model: 'gpt-6-luna', effort: 'max' },
        report: { model: 'gpt-6-luna', effort: 'max' },
        commit: { model: 'gpt-6-luna', effort: 'high' },
      })
  })

  it('uses GPT-6 Luna for Sonnet stages and GPT-6 Sol for Opus stages until GPT-6.1 Sol ships', () => {
    // The catalog the installed codex-cli 0.158.0 lists.
    const available = [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
    ]
    expect(recommendedChoice('codex', 'scout', available)).toEqual({ model: 'gpt-6-luna', effort: 'max' })
    expect(recommendedChoice('codex', 'commit', available)).toEqual({ model: 'gpt-6-luna', effort: 'high' })
    expect(recommendedChoice('codex', 'gen', available)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
    expect(recommendedChoice('codex', 'heal', available)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
  })

  it('climbs a Luna stage to Sol, at the same effort, when GPT-6 Luna is not installed', () => {
    const available = [
      { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
    ]
    expect(recommendedChoice('codex', 'report', available)).toEqual({ model: 'gpt-6-sol', effort: 'max' })
    expect(recommendedChoice('codex', 'commit', available)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
  })

  it('uses an installed older Sol rather than Astra when GPT-6 Sol is unavailable', () => {
    expect(recommendedChoice('codex', 'heal', [
      { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    ])).toEqual({ model: 'gpt-5.6-sol', effort: 'high' })
  })

  it('keeps Claude test authoring and auto-repair at high effort', () => {
    expect(RECOMMENDED_BY_STAGE.claude.gen).toEqual({ model: 'opus', effort: 'high' })
    expect(RECOMMENDED_BY_STAGE.claude.heal).toEqual({ model: 'opus', effort: 'high' })
  })

  it('recommends the Codex Sol role at high effort for coverage mapping', () => {
    const available = [
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    ]

    expect(RECOMMENDED_BY_STAGE.codex.mapping).toEqual({ model: 'sol', effort: 'high' })
    expect(recommendedChoice('codex', 'mapping', available))
      .toEqual({ model: 'gpt-5.6-sol', effort: 'high' })
  })
})

describe('stage plan normalization', () => {
  const raw = {
    heal: { model: null, effort: null },
    commit: { model: 'opus', effort: 'high' },
    // A bad effort with no model is malformed, not a request for agent default.
    report: { model: null, effort: 'minimal' },
    scout: 'not-an-object',
    bogus: { model: 'opus', effort: null },
  }

  it('saved config prunes agent default and junk', () => {
    expect(normalizeStagePlans('claude', raw)).toEqual({ commit: { model: 'opus', effort: 'high' } })
  })

  it('a launch override keeps an explicit agent default and still drops junk', () => {
    expect(normalizeLaunchPlans('claude', raw)).toEqual({
      heal: { model: null, effort: null },
      commit: { model: 'opus', effort: 'high' },
    })
    expect(normalizeLaunchPlans('claude', null)).toEqual({})
  })
})
