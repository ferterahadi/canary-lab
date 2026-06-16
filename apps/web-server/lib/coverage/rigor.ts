import type {
  CoverageLedger,
  Requirement,
  RequirementCoverage,
  RequirementRigor,
  StrictnessTier,
} from '../../../../shared/coverage/types'

// Rigor / strictness scoring (depth spine). Coverage answers "is requirement R
// tested by a passing run?"; rigor answers "is that test actually strict, or
// does it pass trivially?". A requirement can be verified-but-lax (e.g. a "send
// LINE message" test that only checks an app log line).
//
// Two un-absorbable halves, mirroring coverage:
//   • structural — which stack layer each assertion touches is read from the AST
//     snippet (log → tier 1 … browser-at-real-destination → tier 4). Canary
//     classifies; it does not opine.
//   • grounded   — a tier only counts when a passing run reached it (same
//     evidence join as coverage; rigor runs over the VERIFIED tests).
// Strictness = highest passing tier ÷ highest tier the requirement's ladder
// allows. The agent proposes the ladder (per-domain); it never emits the score.

export type ClassifiedTier = StrictnessTier | 'unknown'

export interface ClassifiedAssertion {
  snippet: string
  tier: ClassifiedTier
}

export type { RequirementRigor }

// A real external destination (line.com, api.stripe.com, …) — NOT the app's own
// localhost, which is still the system reporting on itself (tier 3).
const EXTERNAL_URL = /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/i

const NETWORK = /(request|apicontext|fetch|axios|supertest|response)\b/
const NAVIGATION = /(page\.|frame\.|browser\.|goto|waitforurl)/
const UI_ASSERTION = /(page\.|locator|getbyrole|getbytext|getbytestid|tobevisible|tohavetext|tohaveurl|tohavevalue|tocontaintext)/

/**
 * Classify a single assertion/check snippet into a strictness tier by which
 * stack layer it touches. Strongest signal wins; conservative — returns
 * `unknown` rather than guess, leaving it for the agent to resolve.
 */
export function classifyAssertionTier(snippet: string): ClassifiedTier {
  const s = snippet.toLowerCase()

  // tier 4 — a real external destination, reached by the browser or network.
  const external = EXTERNAL_URL.test(snippet)
  if (external && (NAVIGATION.test(s) || NETWORK.test(s) || UI_ASSERTION.test(s))) return 4

  // tier 1 — the app's own log / a file it wrote (self-report).
  if (/(readfilesync|readfile|fs\.read|fs\.|console\.|\.stdout|logfile|\.log['"`)\s]|read[^\n]*\.log)/.test(s)) return 1

  // tier 2 — internal state: DB / ORM / fixture.
  if (/(prisma|knex|sequelize|mongoose|typeorm|\bdb\b|database|\.query\(|repository|\.findone|\.findmany|\.findfirst|fixture|seed)/.test(s)) return 2

  // tier 3 — app/internal API or a UI assertion on the app's own page (the
  // common E2E proxy — the system reports success). A bare fetch/request to a
  // non-external URL counts; the method (GET vs .post()) doesn't matter.
  if (NETWORK.test(s) || UI_ASSERTION.test(s)) return 3

  return 'unknown'
}

export function classifyAssertions(snippets: string[]): ClassifiedAssertion[] {
  return snippets.map((snippet) => ({ snippet, tier: classifyAssertionTier(snippet) }))
}

function ladderMax(requirement: Requirement): StrictnessTier | undefined {
  const ladder = requirement.strictnessLadder
  if (!ladder || !ladder.length) return undefined
  return ladder.reduce<StrictnessTier>((max, rung) => (rung.tier > max ? rung.tier : max), 1)
}

export interface TestAssertions {
  name: string
  assertions: string[]
}

/**
 * Augment a (breadth) coverage ledger with grounded rigor. For each requirement:
 * gather assertions from its VERIFIED tests, take the highest classified tier as
 * `tierReached`, and compare against the ladder ceiling. A fully-broad-verified
 * requirement whose best passing tier is below its ceiling is reclassified
 * `shallow-verified` and gets a feedback payload. Breadth `coveragePct` is
 * preserved (shallow tests are still covered by a passing run).
 */
export function applyRigor(
  ledger: CoverageLedger,
  requirements: Requirement[],
  testAssertions: TestAssertions[],
): CoverageLedger {
  const byReqId = new Map(requirements.map((r) => [r.id, r]))
  const assertionsByTest = new Map(testAssertions.map((t) => [t.name, t.assertions]))

  const reqs: RequirementCoverage[] = ledger.requirements.map((rc) => {
    // Rigor only applies to requirements with ground-truth (a verified test).
    if (!rc.verifiedTestNames.length) return rc

    const classified: ClassifiedAssertion[] = []
    for (const name of rc.verifiedTestNames) {
      classified.push(...classifyAssertions(assertionsByTest.get(name) ?? []))
    }
    const tiered = classified.filter((c): c is { snippet: string; tier: StrictnessTier } => c.tier !== 'unknown')

    const requirement = byReqId.get(rc.requirement.id)
    const tierAvailable = requirement ? ladderMax(requirement) : undefined

    let tierReached: StrictnessTier | undefined
    let weakestAssertion: string | undefined
    if (tiered.length) {
      tierReached = tiered.reduce<StrictnessTier>((max, c) => (c.tier > max ? c.tier : max), 1)
      const weakest = tiered.reduce((min, c) => (c.tier < min.tier ? c : min), tiered[0])
      weakestAssertion = weakest.snippet
    }

    const strictness = tierReached && tierAvailable
      ? Math.round((tierReached / tierAvailable) * 100) / 100
      : undefined
    const suggestedStrongerCheck = tierAvailable && requirement?.strictnessLadder
      ? requirement.strictnessLadder.find((r) => r.tier === tierAvailable)?.description
      : undefined

    const rigor: RequirementRigor = {
      tierReached,
      tierAvailable,
      strictness,
      weakestAssertion,
      suggestedStrongerCheck,
    }

    // Shallow-verified: fully broad-covered, but the best passing tier is below
    // the achievable ceiling. Breadth gaps (path-incomplete/unverified) keep
    // priority — depth only reclassifies an otherwise-clean 'verified'.
    const gapType = rc.gapType === 'verified' && tierReached && tierAvailable && tierReached < tierAvailable
      ? 'shallow-verified'
      : rc.gapType

    return { ...rc, gapType, rigor }
  })

  const verifiedBreadth = reqs.filter((r) => r.gapType === 'verified' || r.gapType === 'shallow-verified').length
  const totals = {
    ...ledger.totals,
    verified: verifiedBreadth,
    shallowVerified: reqs.filter((r) => r.gapType === 'shallow-verified').length,
  }
  const coveragePct = totals.total === 0
    ? 0
    : Math.round((verifiedBreadth / totals.total) * 1000) / 10

  return { ...ledger, requirements: reqs, totals, coveragePct }
}
