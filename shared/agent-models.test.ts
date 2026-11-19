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
  it('prefers GPT-6.2 Sol over older Sol models regardless of catalog order', () => {
    const models = [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { value: 'gpt-6.2-sol', label: 'GPT-6.2-Sol' },
    ]
    for (const catalog of [models, [...models].reverse()]) {
      for (const stage of MODEL_STAGE_KEYS) {
        expect(recommendedChoice('codex', stage, catalog)).toEqual({ model: 'gpt-6.2-sol', effort: 'high' })
      }
    }
  })

  it('selects Terra 6.1, Sol 6.2, and Luna for their respective stages', () => {
    const available = [
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { value: 'gpt-6.2-sol', label: 'GPT-6.2-Sol' },
      { value: 'gpt-6.2-astra', label: 'GPT-6.2-Astra' },
      { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
      { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
    ]
    expect(Object.fromEntries(MODEL_STAGE_KEYS.map((stage) => [stage, recommendedChoice('codex', stage, available)])))
      .toEqual({
        scout: { model: 'gpt-6.1-terra', effort: 'high' },
        docs: { model: 'gpt-6.1-terra', effort: 'high' },
        prd: { model: 'gpt-6.2-sol', effort: 'high' },
        gen: { model: 'gpt-6.2-sol', effort: 'high' },
        mapping: { model: 'gpt-6.2-sol', effort: 'high' },
        heal: { model: 'gpt-6.2-sol', effort: 'high' },
        portify: { model: 'gpt-6.1-terra', effort: 'high' },
        report: { model: 'gpt-6.1-terra', effort: 'high' },
        commit: { model: 'gpt-6-luna', effort: 'high' },
      })
  })

  it('uses GPT-6 Luna and GPT-6 Sol on an older Codex catalog', () => {
    const available = [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
    ]
    expect(recommendedChoice('codex', 'scout', available)).toEqual({ model: 'gpt-6-luna', effort: 'high' })
    expect(recommendedChoice('codex', 'commit', available)).toEqual({ model: 'gpt-6-luna', effort: 'high' })
    expect(recommendedChoice('codex', 'gen', available)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
    expect(recommendedChoice('codex', 'heal', available)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
  })

  it('falls back to Sol when Terra 6.1 and Luna 6 are unavailable', () => {
    const available = [
      { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
    ]
    expect(recommendedChoice('codex', 'report', available)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
    expect(recommendedChoice('codex', 'commit', available)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
  })

  it('uses an installed older Sol when GPT-6 Astra is the only Astra in the catalog', () => {
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
