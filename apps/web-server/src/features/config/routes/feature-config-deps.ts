
import fs from 'fs'
import os from 'os'
import path from 'path'
import { type WorkspaceEventPublisher } from '../../../shared/workspace-events'

export interface FeatureConfigRouteDeps {
  featuresDir: string
  isRepoActive?: (feature: string, repo: string) => boolean
  workspaceEvents?: WorkspaceEventPublisher
  /** R76: deleting a feature deletes its flight history with it — the hook
   *  guards (error string while a flight is active) and removes the records.
   *  Absent (tests without a flight store) → the directory delete proceeds
   *  alone, matching the pre-R76 behavior. */
  removeFlightRecordsFor?: (feature: string) => { error?: string; removed: number }
  /** A suite's `name` IS its identity — every store stamps it on its records.
   *  Editing it therefore renames the suite: `blockedBy` refuses (with a
   *  reason) while live work still holds the old name, and `apply` carries the
   *  rename into flights/runs/coverage/portify/benchmarks/dirty-specs/exports/
   *  drafts. Absent (tests without stores) → the config write proceeds alone. */
  featureRename?: {
    blockedBy: (feature: string) => string | null
    apply: (from: string, to: string) => number
  }
}
