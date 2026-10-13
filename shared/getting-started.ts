/** One key per Getting Started card — the two starters plus the five "More
 *  workflows". Each demo claims under its own key so every card can show its
 *  own attempted/running/completed state. */
export type GettingStartedWorkflow =
  | 'run'
  | 'flight'
  | 'coverage'
  | 'author'
  | 'portify'
  | 'heal'
  // Retained only so an in-flight/pre-upgrade session.json remains readable.
  | 'verify'
  | 'export'
export type GettingStartedOwner = 'internal' | 'external'
/** The Getting Started card a normal run is attributed to: the starter repair
 *  card (`run`) or the workbench run/heal card (`heal`). */
export type GettingStartedRunWorkflow = 'run' | 'heal'
/** What a claim is linked to. `run`/`flight` predate the widening and stay
 *  featureless (persisted session.json records exist in that shape); the newer
 *  kinds carry `feature` because their open-target navigation is feature-first
 *  (the coverage ledger, the suite's flight page pinned to a stage). Both
 *  normal-run cards, plus a legacy `verify` record, reuse kind 'run'. */
export type GettingStartedTarget =
  | { kind: 'run'; id: string }
  | { kind: 'flight'; id: string }
  | { kind: 'draft'; id: string; feature: string }
  | { kind: 'coverage-job'; id: string; feature: string }
  | { kind: 'portify'; id: string; feature: string }
  | { kind: 'export'; id: string; feature: string }

export interface GettingStartedActiveSession {
  sessionId: string
  workflow: GettingStartedWorkflow
  owner: GettingStartedOwner
  target: GettingStartedTarget | null
  startedAt: string
  updatedAt: string
}

export interface GettingStartedCompletion {
  workflow: GettingStartedWorkflow
  owner: GettingStartedOwner
  target: GettingStartedTarget
  status: string
  startedAt: string
  endedAt: string
}

export interface GettingStartedSessionState {
  active: GettingStartedActiveSession | null
  completed: Partial<Record<GettingStartedWorkflow, GettingStartedCompletion>>
}

export type OnboardingWorkflowId =
  | 'run'
  | 'flight'
  | 'coverage'
  | 'export'
  | 'author'
  | 'heal'
  | 'portify'

export type OnboardingWorkflowAction =
  | { kind: 'run'; feature: string }
  | { kind: 'flight'; repoPath: string; description: string }
  | { kind: 'coverage'; feature: string }
  | { kind: 'export'; feature: string }
  | { kind: 'author'; feature: string }
  | { kind: 'heal'; feature: string }
  | { kind: 'portify'; feature: string }

export interface OnboardingWorkflow {
  id: OnboardingWorkflowId
  group: 'start' | 'more'
  order: number
  title: string
  outcome: string
  steps: string[]
  skill: string
  externalPrompt: string
  internalAction: OnboardingWorkflowAction | null
  unavailableReason: string | null
}

export interface OnboardingSamples {
  /** The shipped worked suite, when both it and its product repo are present.
   *  Null once either is gone. */
  sampleSuite: string | null
  /** Absolute path to the bare repo a Flight can onboard, when still present. */
  sampleFlightRepo: string | null
  /** Prefill for that Flight's "what should it test?" field. Null whenever
   *  `sampleFlightRepo` is. */
  sampleFlightDescription: string | null
  /** The executable Getting Started catalog. Server-owned because prompts need
   *  this workspace's absolute paths and actions must reflect which disposable
   *  fixtures still exist on disk. */
  workflows: OnboardingWorkflow[]
  /** Persisted shared state for the four core demos. */
  session: GettingStartedSessionState
}

