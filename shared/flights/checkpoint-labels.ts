import type { FlightCheckpointKind } from './types'

const FLIGHT_CHECKPOINT_TITLE = {
  'similarity-choice': 'Existing suite found — what should this flight do?',
  'config-approval': 'Does this setup look right?',
  'missing-env': 'Some settings are missing',
  'prd-source': 'Where should requirements come from?',
  'coverage-stuck': 'Coverage stopped short of the target',
  'portify-gate': 'Make this suite safe to run twice at once?',
  'portify-apply': 'Save these port changes?',
  'run-failed': 'The test run did not pass — rerun or build the report?',
  'export-mode': 'How should the evaluation report be built?',
  'external-work': 'External agent work',
} as const satisfies Record<FlightCheckpointKind, string>

export function flightCheckpointTitle(kind: string): string {
  return FLIGHT_CHECKPOINT_TITLE[kind as FlightCheckpointKind] ?? kind
}
