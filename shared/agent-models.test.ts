import { describe, expect, it } from 'vitest'
import { KNOWN_MODELS, RECOMMENDED_BY_STAGE, recommendedChoice } from './agent-models.ts'

describe('KNOWN_MODELS', () => {
  it('derives the recognized Claude ids from the curated dropdown options', () => {
    expect(KNOWN_MODELS.claude).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})

describe('RECOMMENDED_BY_STAGE', () => {
  it('keeps Claude test authoring and auto-repair at maximum effort', () => {
    expect(RECOMMENDED_BY_STAGE.claude.gen).toEqual({ model: 'opus', effort: 'max' })
    expect(RECOMMENDED_BY_STAGE.claude.heal).toEqual({ model: 'opus', effort: 'max' })
  })

  it('recommends the Codex Sol role at high effort for coverage mapping', () => {
    const available = [
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    ]

    expect(recommendedChoice('codex', 'mapping', available))
      .toEqual({ model: 'gpt-5.6-sol', effort: 'medium' })
  })
})
