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
 * A feature-level VARIANT dimension (D1: at most one per feature). A variant is a
 * domain value a single requirement must hold across — channel (email / whatsapp /
 * call / line), tenant, region, role, plan-tier. It is the third coverage axis:
 * coverage becomes `requirement × path × variant`, so a requirement that bundles
 * N variants but is only tested on one is `variant-incomplete`, not `covered`.
 *
 * Declared ONCE by the PRD-summary agent; absent ⇒ the feature has no variant
 * dimension and coverage stays the 2-axis `requirement × path` model (unchanged).
 */
export interface VariantDimension {
  /** What the dimension is called (e.g. "channel"). Lower-case, single token. */
  name: string
  /** The closed set of values a requirement may span (e.g. ["email","whatsapp"]).
   *  The controlled vocabulary: test `@variant-*` claims outside this set are dropped. */
  values: string[]
}

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
  /** Variant values (from the feature's `variantDimension`) this requirement must
   *  hold across — e.g. ["email","whatsapp","call","line"]. Absent / empty ⇒ the
   *  requirement is variant-agnostic and coverage uses paths only (today's model).
   *  Every value must be one of `PrdSummary.variantDimension.values`. */
  variants?: string[]
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
  /** The feature's single variant dimension (D1), if it has one. Declared by the
   *  PRD-summary agent; drives the `requirement × path × variant` coverage matrix.
   *  Absent ⇒ no variant axis (the 2-axis model). */
  variantDimension?: VariantDimension
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

// Semantic coverage is decoupled from test RUNS (R: 1.4.0): it asks "does a test
// exist that claims to exercise this requirement's paths?", never "did a run pass?".
export type GapType =
  | 'covered'
  | 'path-incomplete'
  | 'variant-incomplete'
  | 'untested'

/**
 * Coarse tri-state per requirement — derived from the finer `GapType`:
 *   • covered   — every declared (path × variant) cell is claimed by a mapped test
 *   • uncovered — untested (no test mapped at all)
 *   • partial   — path-incomplete OR variant-incomplete (some cells unclaimed)
 */
export type CoverageStatus = 'covered' | 'partial' | 'uncovered'

export interface PathCoverage {
  path: PathType
  /** A mapped test claims (declares) this path (variant ignored — the 2-axis view). */
  covered: boolean
}

/**
 * One cell of a variant-bearing requirement's `path × variant` matrix. Present
 * only for requirements that declare `variants`; the cell is covered when some
 * mapped test claims BOTH this path AND this variant. This is the axis the
 * 2-axis ledger was blind to (a "config on all 4 channels" requirement marked
 * covered by an email-only test).
 */
export interface VariantCellCoverage {
  path: PathType
  variant: string
  covered: boolean
}

/**
 * How strong a test's coverage is — graded off the strongest stack layer its
 * assertions actually touch (the tier classifier). Independent of test runs:
 *   • strong (tier 4) — a real external destination / browser confirms the effect
 *   • solid  (tier 3) — an app/internal API or UI assertion reports success
 *   • basic  (tier 2) — internal state changed (DB row / fixture)
 *   • shallow(tier 1) — only the app's own log / self-report (or no classifiable tier)
 */
export type TestStrength = 'strong' | 'solid' | 'basic' | 'shallow'

export interface TestCoverage {
  name: string
  file?: string
  line?: number
  requirements: string[]
  pathTypes: PathType[]
  /** Variant value(s) this test exercises (from `@variant-*` tags), e.g.
   *  ["email"]. Absent ⇒ variant-agnostic; contributes to no specific variant
   *  cell of a variant-bearing requirement. */
  variants?: string[]
  /** Static coverage strength, graded from the test's own assertions (strength.ts). */
  strength?: TestStrength
}

export interface RequirementCoverage {
  requirement: Requirement
  annotatedTestNames: string[]
  pathCoverage: PathCoverage[]
  /** The `path × variant` matrix — present only when the requirement declares
   *  `variants`. Drives the grid in the UI and the `variant-incomplete` gap. */
  variantCoverage?: VariantCellCoverage[]
  gapType: GapType
  /** Coarse covered/partial/uncovered roll-up of `gapType`. */
  coverageStatus: CoverageStatus
}

export interface CoverageTotals {
  total: number
  covered: number
  pathIncomplete: number
  /** Requirements with a variant axis where some (path × variant) cell is unclaimed. */
  variantIncomplete: number
  untested: number
  /** Tests carrying no requirement linkage — candidates for the annotate-pass. */
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
  /** Variant value(s) the test exercises, validated against the feature's
   *  `variantDimension.values` (unknowns dropped). Absent ⇒ variant-agnostic. */
  variants?: string[]
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
  /** covered ÷ total active requirements, 0–100, one decimal. A requirement is
   *  covered when every declared path is claimed by a mapped test. */
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
  /** Execution model. Absent / 'internal' = Canary spawned its own agent CLI
   *  (the default coverage flow). 'external' = an MCP client did the annotation
   *  itself (offload model) and Canary only tracks + recomputes the ledger; such
   *  a job has NO sessionRef, so the Generating screen renders it monitor-only. */
  producer?: 'internal' | 'external'
  /** External-producer metadata, set only when producer === 'external'. */
  externalClientKind?: string
  externalSessionId?: string
  externalConversationName?: string
  externalSessionUrl?: string
}

export interface CoverageJobIndexEntry {
  jobId: string
  feature: string
  kind: CoverageJobKind
  status: CoverageJobStatus
  startedAt: string
  endedAt?: string
}
