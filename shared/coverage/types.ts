// Verified Coverage Ledger — shared data model.
//
// Two grounded dimensions about a feature's tests:
//   • breadth — which PRD requirements are covered by a passing run (coverage %)
//   • depth   — how strict each covering test actually is (strictness score)
//
// These types are consumed by the web-server (computation + MCP) and the web UI,
// so they live in `shared/`. The headline numbers are always evidence-based math
// computed by canary — never an agent's opinion (see docs/PRD.md).

/** Path types a requirement implies / a test exercises. */
export type PathType = 'happy' | 'sad' | 'edge'

/**
 * Assertion strictness tiers — how close a check gets to the real,
 * user-observable effect. Tier 1 = "looks like it works"; tier 4 = "works".
 *   1 — app log / self-report ("sent")
 *   2 — internal state (DB row, fixture)
 *   3 — app/internal API reports success
 *   4 — browser drives the real destination and observes the real effect
 */
export type StrictnessTier = 1 | 2 | 3 | 4

/** One rung of a requirement's agent-proposed strictness ladder. */
export interface StrictnessLadderRung {
  tier: StrictnessTier
  /** What a check at this tier looks like for this requirement (per-domain). */
  description: string
}

/** A single requirement extracted from the PRD docs collection. */
export interface Requirement {
  /** Stable id, durable across PRD regeneration (e.g. "R1"). The spine the
   *  inline `@requirement` annotations point at — never renumbered. */
  id: string
  title: string
  /** The requirement statement, phrased as an "it should …" expectation. */
  text: string
  /** Functional (a behavior the feature does/supports) vs non-functional (a
   *  quality constraint). Drives PRD-summary section grouping. Defaults to
   *  functional when absent (older summaries / deterministic fallback). */
  kind?: 'functional' | 'non-functional'
  /** Expected flow when inputs are valid and everything works. */
  happyPath?: string
  /** Error / edge / failure handling: invalid input, denial, conflicts, limits. */
  unhappyPath?: string
  /** Char offset range within the rendered PRD summary markdown, for UI
   *  highlighting. Optional — absent when the summary text isn't span-mapped. */
  sourceRange?: { start: number; end: number }
  /** Path-types this requirement implies (happy / sad / edge). */
  pathTypes: PathType[]
  /** Agent-proposed strictness ladder (per-domain: LINE vs payment vs email).
   *  Stored so rigor scoring has a stable, per-requirement ceiling. */
  strictnessLadder?: StrictnessLadderRung[]
  /** Set when a requirement present in a prior summary was dropped on regen.
   *  Kept (not deleted) so existing annotations don't dangle silently. */
  deprecated?: boolean
  /** Content fingerprint (title+text+paths) stored at generation time (R3). The
   *  id is the durable spine; this captures whether the MEANING shifted, so a
   *  regen can (R10) re-infer only the requirements that actually changed. */
  fingerprint?: string
}

/**
 * Structured PRD summary sidecar, stored next to the generated markdown under
 * `features/<feature>/docs/` (e.g. `_prd-summary.json` + `_prd-summary.md`).
 */
export interface PrdSummary {
  requirements: Requirement[]
  /** Stable hash of the source docs collection this summary was built from. */
  docsHash: string
  /** Relative doc paths (sorted) that fed this summary. */
  sourceDocs: string[]
  /** ISO timestamp of generation. */
  generatedAt: string
  /** Per-doc fingerprints at generation time (R3) — relPath → hash. Lets drift
   *  name WHICH docs changed, not just THAT something did. */
  docFingerprints?: Record<string, string>
  /** Hash over the active requirements set — the key coverage staleness is
   *  measured against (changes on add/remove/edit of a requirement). */
  requirementsHash?: string
}

// --- Coverage state model (R3). Summary and Coverage are independent axes; the
// UI shows one derived headline and every (summary × coverage) combination has a
// non-dead-end rendering. ---

/** Summary axis: the PRD summary's lifecycle. */
export type SummaryState = 'absent' | 'generating' | 'fresh' | 'stale'

/** Coverage axis: BLOCKED until the summary is FRESH, then absent→…→stale. */
export type CoverageState = 'blocked' | 'absent' | 'generating' | 'fresh' | 'stale'

/** What changed and what it invalidated — staleness never just says "stale". */
export interface DriftDetail {
  drifted: boolean
  /** Source docs added/edited/removed since the summary was generated. */
  changedDocs: string[]
  /** Human-named artifacts the change invalidates (PRD summary / coverage). */
  affectedArtifacts: string[]
}

/** The derived state view surfaced on the ledger (drives the compact UI). */
export interface CoverageStateView {
  summary: SummaryState
  coverage: CoverageState
  /** One-line derived headline: Generating / Setup needed / Stale / No coverage
   *  / Covered N%. */
  headline: string
  drift: DriftDetail
}

// --- Computed coverage ledger (the output of the breadth + depth computation,
// consumed by both the REST/UI surface and the MCP tool). ---

export type GapType =
  | 'verified'
  | 'untested'
  | 'unverified'
  | 'path-incomplete'
  | 'shallow-verified'

/**
 * Coarse tri-state the coverage engine compiles per requirement — the headline
 * the agent and the ledger pane group on, derived from the finer `GapType`:
 *   • covered   — verified (a passing run behind every implied path)
 *   • uncovered — untested (no test linked at all)
 *   • partial   — anything in between (unverified / path-incomplete /
 *                 shallow-verified)
 */
export type CoverageStatus = 'covered' | 'partial' | 'uncovered'

/** The most-recent run in which a test actually passed — the evidence pointer. */
export interface LastPassingRun {
  testName: string
  runId: string
  env?: string
  /** When the run ended (or started, as a fallback). */
  at?: string
}

export interface PathCoverage {
  path: PathType
  verified: boolean
}

export interface TestCoverage {
  name: string
  file?: string
  line?: number
  requirements: string[]
  pathTypes: PathType[]
  /** Has a passing run behind it. */
  verified: boolean
  lastPassingRun?: LastPassingRun
}

/** Grounded depth signal for one requirement (the "test fairness" report). */
export interface RequirementRigor {
  /** Highest assertion tier reached by a VERIFIED covering test. */
  tierReached?: StrictnessTier
  /** Highest tier the requirement's agent-proposed ladder allows. */
  tierAvailable?: StrictnessTier
  /** tierReached ÷ tierAvailable, 0–1, when both known. */
  strictness?: number
  /** The lowest-tier assertion among verified tests — the weak link. */
  weakestAssertion?: string
  /** What a top-of-ladder check looks like (rung at tierAvailable). */
  suggestedStrongerCheck?: string
}

export interface RequirementCoverage {
  requirement: Requirement
  annotatedTestNames: string[]
  verifiedTestNames: string[]
  lastPassingRun?: LastPassingRun
  pathCoverage: PathCoverage[]
  gapType: GapType
  /** Coarse covered/partial/uncovered roll-up of `gapType` (engine headline). */
  coverageStatus: CoverageStatus
  /** Present once the rigor layer has run over a verified requirement. */
  rigor?: RequirementRigor
}

export interface CoverageTotals {
  total: number
  verified: number
  untested: number
  unverified: number
  pathIncomplete: number
  shallowVerified: number
  /** Tests carrying no requirement linkage (covered/partial/uncovered ignore
   *  these — they're candidates for the annotate-pass). */
  orphanTests: number
}

/** One coverage-engine test→requirement mapping (the annotate-pass output).
 *  The engine writes the `covers` tag for each immediately (no review gate); the
 *  agent only ever proposes a MAPPING, never a test body. Internal to the engine
 *  + the applied-count surface — not a UI review queue. */
export interface ProposedMapping {
  testName: string
  file?: string
  requirements: string[]
  pathTypes?: PathType[]
  rationale?: string
  /** 0–1 confidence (deterministic lane = token-overlap ratio). */
  confidence?: number
  /** Which lane produced it. */
  source: 'agent' | 'deterministic'
}

export interface CoverageLedger {
  feature: string
  requirements: RequirementCoverage[]
  tests: TestCoverage[]
  totals: CoverageTotals
  /** verified ÷ total active requirements, 0–100, one decimal. Depth/quality:
   *  the share with a *passing run* behind every path. */
  coveragePct: number
  /** Breadth: requirements with ≥1 annotated test ÷ total active, 0–100, one
   *  decimal. "How many requirements have a corresponding test case" — answers
   *  coverage existence independent of whether the test passes. */
  mappedPct: number
  /** Requirement ids annotated on tests but absent from the PRD (drift signal). */
  orphanRequirementIds: string[]
  /** Test names with no requirement linkage — the annotate-pass works this set. */
  orphanTestNames: string[]
  /** Derived (summary × coverage) state + drift detail (R3). */
  state?: CoverageStateView
  /** True when the live docs hash differs from the summary's stored hash.
   *  @deprecated superseded by `state.drift.drifted` — kept for back-compat. */
  docsDrift?: boolean
}

// --- Async background jobs (R4). Shared so the UI dialog/pill and the MCP tools
// read the same manifest shape. ---

export type CoverageJobKind = 'summary' | 'coverage'

export type CoverageJobStatus = 'running' | 'done' | 'failed' | 'aborted'

export interface CoverageJobResult {
  /** summary jobs: active requirement count after the regen. */
  requirementCount?: number
  /** coverage jobs: number of `covers` tags written this pass. */
  applied?: number
}

export interface CoverageJobManifest {
  jobId: string
  feature: string
  kind: CoverageJobKind
  status: CoverageJobStatus
  startedAt: string
  endedAt?: string
  /** Captured agent/driver output — streamed into the Generating screen. */
  log: string
  /** Summary + Coverage are one exercise: a `summary` job auto-starts a follow-on
   *  `coverage` job on success and records its id here, so the UI can keep
   *  streaming across both phases without a second click (R14). */
  chainedJobId?: string
  /** Set on the chained coverage job, pointing back at the summary job that
   *  spawned it. */
  chainedFromJobId?: string
  /** The agent CLI session backing this job, when one was pinned — lets the
   *  Generating screen mount the structured AgentSessionView (R17). */
  sessionRef?: { agent: 'claude' | 'codex'; sessionId: string }
  result?: CoverageJobResult
  error?: string
}

export interface CoverageJobIndexEntry {
  jobId: string
  feature: string
  kind: CoverageJobKind
  status: CoverageJobStatus
  startedAt: string
  endedAt?: string
}
