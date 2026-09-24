import type { FlightStageKey } from '@/shared/api/client'

/** User-facing rows. The conductor's execution order and persisted stage order
 *  stay separate from this grouping. */
export const FLIGHT_STAGE_SECTIONS = [
  { id: 'setup', label: 'Setup', keys: ['scout', 'scaffold', 'docs'] },
  { id: 'verification', label: 'Verification cycle', keys: ['specs-coverage', 'run', 'evaluation-export'] },
  { id: 'independent', label: 'Run separately', keys: ['portify'] },
] as const satisfies readonly {
  id: string
  label: string
  keys: readonly FlightStageKey[]
}[]

export const FLIGHT_SECTION_ROW_KEYS: readonly FlightStageKey[] = FLIGHT_STAGE_SECTIONS.flatMap((section) => section.keys)
