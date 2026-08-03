import { describe, it, expect } from 'vitest'
import { modelArgs, modelFor, healModelsFromEnv, HEAL_MODELS } from './agent-models'

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
})
