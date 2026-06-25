import { describe, it, expect } from 'vitest'
import { modelArgs, modelFor, HEAL_MODELS } from './agent-models'

describe('modelArgs', () => {
  it('returns ["--model", id] when a model string is provided', () => {
    expect(modelArgs('claude-opus-4')).toEqual(['--model', 'claude-opus-4'])
  })

  it('returns [] when model is null (agent default)', () => {
    expect(modelArgs(null)).toEqual([])
  })
})

describe('modelFor', () => {
  it('returns the claude field for the claude agent', () => {
    expect(modelFor({ claude: 'claude-haiku', codex: null }, 'claude')).toBe('claude-haiku')
  })

  it('returns the codex field for the codex agent', () => {
    expect(modelFor({ claude: null, codex: 'gpt-5' }, 'codex')).toBe('gpt-5')
  })

  it('HEAL_MODELS are null by default (agent default for both agents)', () => {
    expect(modelFor(HEAL_MODELS, 'claude')).toBeNull()
    expect(modelFor(HEAL_MODELS, 'codex')).toBeNull()
  })
})
