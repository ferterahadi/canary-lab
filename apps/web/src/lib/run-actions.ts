// Pure predicates for the actions that can be invoked on a run row in the
// UI. Kept out of the React component so the rules are easy to test and
// reason about without rendering anything.

import type { RunStatus } from '../api/types'

// True only when the run is actively executing tests (not yet healing, not
// yet terminal). Healing is excluded because the heal agent is already
// running — there's nothing to pause. Passed/failed/aborted are terminal.
export function canPauseHeal(status: RunStatus): boolean {
  return status === 'running'
}
