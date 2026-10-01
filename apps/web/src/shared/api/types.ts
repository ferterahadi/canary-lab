import type { SpecDiff, TestChange } from '@shared/verification-strength/types'
import type {
  FlightCheckpointKind,
  FlightPauseReason,
  FlightStageKey,
  FlightStatus,
} from '@shared/flights/types'
import type { FeatureStageEvidence } from '@shared/flights/stage-evidence'
import type { ExtractedTest } from '@shared/extracted-test'

export interface FeatureRepo {
  name: string
  localPath: string
  branch?: string
}

export interface DirtySpecSummary {
  file: string
  affectedTests: string[]
  /** The verification-strength differential for this spec: its assertions
   *  before the edit against now, from the run-start copy when a run took one,
   *  else the committed spec. Each changed test carries the `@requirement` ids
   *  the live spec gives it. Absent when no baseline content is readable. An
   *  advisory reading (D13) — nothing here changes a verdict. */
  strength?: DirtySpecStrength
}

export interface DirtySpecStrength extends SpecDiff {
  baseline: 'run-start' | 'head'
  tests: Array<TestChange & { requirements?: string[] }>
}

export interface FeatureDirtyState {
  status: 'clean' | 'dirty'
  /** Modified spec files (relative to the feature dir), with their test titles.
   *  Only populated when status is 'dirty'. */
  specs: DirtySpecSummary[]
}

/** Client-only placeholder marker — the server NEVER sets this. Present when a
 *  ledger row stands in for a First-Flight batch flight that hasn't scaffolded
 *  its `feature.config.cjs` yet: the flight record exists (queued/running) but
 *  the feature is not on disk. The ledger renders such a row muted, cog-less,
 *  and clicking it opens the flight. Synthesized by `derivePendingFeatures`;
 *  replaced by the real feature (dedup by name) once scaffold writes the config
 *  and the `feature-created` event refetches the list. */
export interface FeaturePending {
  flightId: string
  status: FlightStatus
  currentStage: FlightStageKey | null
  pauseReason?: FlightPauseReason
  /** Which kind of stop a parked flight is on — carried so the column can tell
   *  a question for the human from an `external-work` hand-off, where the step
   *  is running in the user's own agent and asks nothing of this reader. */
  checkpointKind?: FlightCheckpointKind
  /** Who drives the flight — an externally driven one asks nothing of this
   *  reader whatever it is parked on (see flightAwaitsUser). */
  stageProducer?: 'internal' | 'external'
}

export interface Feature {
  name: string
  description?: string
  /** Set only on synthesized placeholder rows — see FeaturePending. Absent on
   *  every real feature the server returns. */
  pending?: FeaturePending
  /** Optional grouping label — features sharing a group render under one
   *  section in the UI. Absent when the feature declares no group. */
  group?: string
  repos: FeatureRepo[]
  envs: string[]
  /** A saved port overlay exists (features/<feature>/portify/) → boots
   *  concurrently. Drives the "Portified" badge. Optional: absent in older
   *  payloads. */
  portified?: boolean
  /** On-disk stage artifacts — feeds the picker's evidence-derived stage rail
   *  for features with no flight record. Optional: absent in older payloads
   *  (the rail then falls back to all-pending / "not flown"). */
  evidence?: FeatureStageEvidence
  /** Test-file integrity. 'dirty' when a spec changed since the last green (or
   *  run-start) and wasn't approved/committed. Drives the red cue. Optional:
   *  absent in older payloads / when integrity tracking is off. */
  dirty?: FeatureDirtyState
}

export interface FeatureSpecFile {
  file: string
  tests: ExtractedTest[]
  /** Recorded identities are available, but their historical source is not. */
  recordedSourceUnavailable?: boolean
  parseError?: string
  discoveryError?: string
  discoveryDiagnostics?: string
  discoveryRepairPrompt?: string
}

export type FeatureTests = FeatureSpecFile[]

