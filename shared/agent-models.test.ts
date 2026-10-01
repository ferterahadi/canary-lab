import { describe, expect, it } from 'vitest'
import { KNOWN_MODELS, MODEL_STAGE_KEYS, RECOMMENDED_BY_STAGE, recommendedChoice } from './agent-models.ts'

describe('KNOWN_MODELS', () => {
  it('derives the recognized Claude ids from the curated dropdown options', () => {
    expect(KNOWN_MODELS.claude).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})

describe('RECOMMENDED_BY_STAGE', () => {
  it('prefers GPT-6.1 Sol over older Sol models regardless of catalog order', () => {
    const models = [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    ]
    for (const catalog of [models, [...models].reverse()]) {
      for (const stage of MODEL_STAGE_KEYS) {
        expect(recommendedChoice('codex', stage, catalog)).toEqual({
          model: 'gpt-6.1-sol',
          effort: stage === 'commit' ? 'medium' : 'high',
        })
      }
    }
  })

  it('keeps balanced stages on visible GPT-6 Terra while deep stages use GPT-6.1 Sol', () => {
    const available = [
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { value: 'gpt-6-terra', label: 'GPT-6-Terra' },
    ]
    for (const stage of ['scout', 'docs', 'portify', 'report', 'commit'] as const) {
      expect(recommendedChoice('codex', stage, available).model).toBe('gpt-6-terra')
    }
    for (const stage of ['prd', 'gen', 'mapping', 'heal'] as const) {
      expect(recommendedChoice('codex', stage, available)).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
    }
  })

  it('uses GPT-6 Sol for every Codex stage while GPT-6 Terra is unavailable', () => {
    const available = [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
    ]
    expect(Object.fromEntries(MODEL_STAGE_KEYS.map((stage) => [stage, recommendedChoice('codex', stage, available)])))
      .toEqual({
        scout: { model: 'gpt-6-sol', effort: 'high' },
        docs: { model: 'gpt-6-sol', effort: 'high' },
        prd: { model: 'gpt-6-sol', effort: 'high' },
        gen: { model: 'gpt-6-sol', effort: 'high' },
        mapping: { model: 'gpt-6-sol', effort: 'high' },
        heal: { model: 'gpt-6-sol', effort: 'high' },
        portify: { model: 'gpt-6-sol', effort: 'high' },
        report: { model: 'gpt-6-sol', effort: 'high' },
        commit: { model: 'gpt-6-sol', effort: 'medium' },
      })
  })

  it('uses GPT-6 Terra for balanced stages once visible, keeping authoring and repair on Sol', () => {
    const available = [
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { value: 'gpt-6-terra', label: 'GPT-6-Terra' },
      { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
    ]
    expect(recommendedChoice('codex', 'scout', available)).toEqual({ model: 'gpt-6-terra', effort: 'high' })
    expect(recommendedChoice('codex', 'commit', available)).toEqual({ model: 'gpt-6-terra', effort: 'medium' })
    expect(recommendedChoice('codex', 'gen', available)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
    expect(recommendedChoice('codex', 'heal', available)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
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
