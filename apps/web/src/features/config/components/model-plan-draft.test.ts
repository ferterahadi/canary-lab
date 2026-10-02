import { describe, expect, it } from 'vitest'
import { AGENT_DEFAULT_CHOICE, recommendedChoice, type KnownModelOption } from '@shared/agent-models'
import {
  choiceText,
  draftChoice,
  draftDirty,
  recommendedDraft,
  rowState,
  seedDraft,
  toLaunchOverride,
  toSavedPlans,
} from './model-plan-draft'

const CONFIG = {
  claude: { heal: { model: 'opus', effort: 'high' } },
  codex: {},
}

describe('model plan draft', () => {
  it('seeds every scoped stage — unpinned ones as an explicit agent default', () => {
    expect(seedDraft('claude', ['heal', 'commit'], CONFIG)).toEqual({
      heal: { model: 'opus', effort: 'high' },
      commit: AGENT_DEFAULT_CHOICE,
    })
  })

  it('an unscoped stage reads as agent default', () => {
    expect(draftChoice({}, 'scout')).toEqual(AGENT_DEFAULT_CHOICE)
  })

  it('recommends exactly the scoped stages', () => {
    const draft = recommendedDraft('claude', ['prd', 'mapping'], [])
    expect(Object.keys(draft)).toEqual(['prd', 'mapping'])
    expect(draft.prd).toEqual(recommendedChoice('claude', 'prd'))
  })

  it('codex recommendations follow the installed catalog', () => {
    const options: KnownModelOption[] = [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }]
    expect(recommendedDraft('codex', ['heal'], options).heal?.model).toBe('gpt-5.6-sol')
  })

  it('is dirty only while a scoped row differs from the seed', () => {
    const seed = seedDraft('claude', ['heal', 'commit'], CONFIG)
    expect(draftDirty(seed, seed, ['heal', 'commit'])).toBe(false)
    expect(draftDirty({ ...seed, commit: { model: 'haiku', effort: null } }, seed, ['heal', 'commit'])).toBe(true)
  })

  it('saved plans prune agent default; a launch override keeps it explicit', () => {
    const seed = seedDraft('claude', ['heal', 'commit'], CONFIG)
    const draft = { ...seed, heal: AGENT_DEFAULT_CHOICE }
    expect(toSavedPlans(draft)).toEqual({})
    // The saved pin on heal must be overridden, so the override names it.
    expect(toLaunchOverride(draft, seed, ['heal', 'commit'])).toEqual({
      heal: AGENT_DEFAULT_CHOICE,
      commit: AGENT_DEFAULT_CHOICE,
    })
  })

  it('an unchanged launch draft sends no override at all', () => {
    const seed = seedDraft('claude', ['heal'], CONFIG)
    expect(toLaunchOverride(seed, seed, ['heal'])).toBeNull()
  })

  it('classifies a row as recommended, default, or custom', () => {
    expect(rowState('claude', 'heal', recommendedChoice('claude', 'heal'), [])).toBe('recommended')
    expect(rowState('claude', 'heal', AGENT_DEFAULT_CHOICE, [])).toBe('default')
    expect(rowState('claude', 'heal', { model: 'haiku', effort: 'low' }, [])).toBe('custom')
  })

  it('spells a choice for display', () => {
    expect(choiceText({ model: 'opus', effort: 'high' })).toBe('opus · high')
    expect(choiceText(AGENT_DEFAULT_CHOICE)).toBe('agent default')
  })
})
