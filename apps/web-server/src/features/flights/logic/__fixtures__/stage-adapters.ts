import { FLIGHT_STAGE_KEYS, type FlightStageKey } from '../../../../../../../shared/flights/types'
import type { StageAdapter, StageAdapters } from '../flight-stages'

/** A stage that finishes at once and owns no work to tear down. With `calls`,
 *  each run records the stage the flight was on, so a suite can assert the
 *  order the conductor walked the stages in. */
export const doneAdapter = (calls?: FlightStageKey[]): StageAdapter => ({
  teardown: () => null,
  run: async (ctx) => {
    calls?.push(ctx.manifest().currentStage as FlightStageKey)
    return { kind: 'done' }
  },
})

/** Every stage as a `doneAdapter`, so a flight runs straight through unless a
 *  suite swaps in the one stage it is testing. */
export function allDoneAdapters(calls?: FlightStageKey[]): StageAdapters {
  return Object.fromEntries(FLIGHT_STAGE_KEYS.map((k) => [k, doneAdapter(calls)])) as StageAdapters
}
