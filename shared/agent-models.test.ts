import { describe, expect, it } from 'vitest'
import { KNOWN_MODELS, MODEL_STAGE_KEYS, RECOMMENDED_BY_STAGE, recommendedChoice } from './agent-models.ts'

describe('KNOWN_MODELS', () => {
  it('derives the recognized Claude ids from the curated dropdown options', () => {
    expect(KNOWN_MODELS.claude).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})

describe('RECOMMENDED_BY_STAGE', () => {
  it('reserves Astra for test authoring and repair regardless of catalog order', () => {
    const available = [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
    ]
    expect(Object.fromEntries(MODEL_STAGE_KEYS.map((stage) => [stage, recommendedChoice('codex', stage, available)])))
      .toEqual({
        scout: { model: 'gpt-5.6-terra', effort: 'high' },
        docs: { model: 'gpt-5.6-terra', effort: 'high' },
        prd: { model: 'gpt-5.6-sol', effort: 'high' },
        gen: { model: 'gpt-6-astra', effort: 'high' },
        mapping: { model: 'gpt-5.6-sol', effort: 'high' },
        heal: { model: 'gpt-6-astra', effort: 'high' },
        portify: { model: 'gpt-5.6-terra', effort: 'high' },
        report: { model: 'gpt-5.6-terra', effort: 'high' },
        commit: { model: 'gpt-5.6-terra', effort: 'medium' },
      })
  })

  it('resolves future Astra versions without requiring Sol in the catalog', () => {
    expect(recommendedChoice('codex', 'heal', [{ value: 'gpt-7-astra', label: 'GPT-7-Astra' }]))
      .toEqual({ model: 'gpt-7-astra', effort: 'high' })
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
