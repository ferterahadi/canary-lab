import { describe, expect, it } from 'vitest'
import { FLIGHT_STAGE_KEYS } from './types'
import { FLIGHT_STAGE_LABEL, flightStageLabel } from './stage-labels'

describe('flightStageLabel', () => {
  it('labels every stage key the pipeline defines', () => {
    for (const key of FLIGHT_STAGE_KEYS) {
      expect(flightStageLabel(key)).toBe(FLIGHT_STAGE_LABEL[key])
      expect(flightStageLabel(key)).not.toBe('')
    }
  })

  it('falls back to the raw key for a stage this build does not know', () => {
    // Server and web can be one release apart mid-upgrade: a record written by
    // a newer build must still render as SOMETHING, not an empty label.
    expect(flightStageLabel('brand-new-stage')).toBe('brand-new-stage')
  })
})
