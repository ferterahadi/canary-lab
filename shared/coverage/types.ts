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
  /** The requirement statement. */
  text: string
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
}

// --- Computed coverage ledger (the output of the breadth + depth computation,
// consumed by both the REST/UI surface and the MCP tool). ---

export type GapType =
  | 'verified'
  | 'untested'
  | 'unverified'
  | 'path-incomplete'
  | 'shallow-verified'

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
}

export interface CoverageLedger {
  feature: string
  requirements: RequirementCoverage[]
  tests: TestCoverage[]
  totals: CoverageTotals
  /** verified ÷ total active requirements, 0–100, one decimal. */
  coveragePct: number
  /** Requirement ids annotated on tests but absent from the PRD (drift signal). */
  orphanRequirementIds: string[]
  /** True when the live docs hash differs from the summary's stored hash. */
  docsDrift?: boolean
}
