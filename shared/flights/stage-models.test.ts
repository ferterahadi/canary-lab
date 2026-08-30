import { describe, expect, it } from 'vitest'
import { FLIGHT_ROW_MODEL_STAGES, flightRowModelChips } from './stage-models.ts'

describe('flightRowModelChips', () => {
  it('reports a merged row’s companion spawns under the row that owns them', () => {
    expect(flightRowModelChips('run', {
      heal: { model: 'opus', effort: 'max' },
      commit: { model: 'sonnet', effort: 'medium' },
    })).toEqual([
      { stage: 'heal', label: 'Auto-repair', value: 'opus · max', title: 'Auto-repair runs on opus · max — locked when this flight started' },
      { stage: 'commit', label: 'Commit message', value: 'sonnet · medium', title: 'Commit message runs on sonnet · medium — locked when this flight started' },
    ])
  })

  it('collapses spawns that share the same knobs into one chip naming both', () => {
    expect(flightRowModelChips('docs', {
      docs: { model: 'sonnet', effort: 'high' },
      prd: { model: 'sonnet', effort: 'high' },
    })).toEqual([{
      stage: 'docs',
      // Both spawns share the knobs, so ONE chip names both as its subject.
      label: 'Doc collection + Requirements summary',
      value: 'sonnet · high',
      title: 'Doc collection and Requirements summary run on sonnet · high — locked when this flight started',
    }])
  })

  it('shows the knob that WAS pinned when only one of the two is set', () => {
    expect(flightRowModelChips('specs-coverage', { gen: { model: null, effort: 'max' } }))
      .toEqual([{
        stage: 'gen',
        label: 'Test authoring',
        value: 'max',
        title: 'Test authoring runs on max — locked when this flight started',
      }])
  })

  it('says nothing for a step on the agent default, an absent plan, or a step that spawns no agent', () => {
    expect(flightRowModelChips('run', { heal: { model: null, effort: null } })).toEqual([])
    expect(flightRowModelChips('portify', undefined)).toEqual([])
    // Suite setup, the settings snapshot and the similarity pre-check never
    // spawn an agent — the map has no entry, so no model can be claimed there.
    expect(flightRowModelChips('scaffold', { heal: { model: 'opus', effort: 'max' } })).toEqual([])
    expect(FLIGHT_ROW_MODEL_STAGES['env-capture']).toBeUndefined()
    expect(FLIGHT_ROW_MODEL_STAGES.similarity).toBeUndefined()
  })
})
