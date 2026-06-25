import type {
  CoverageLedger,
  StrictnessTier,
  TestStrength,
} from '../../../../../../../shared/coverage/types'

// Per-test coverage STRENGTH (depth) — decoupled from test runs. Each test is
// graded by the strongest stack layer its assertions actually touch, read from
// the AST snippet (log → tier 1 … real-external-destination → tier 4). Canary
// classifies; it does not opine. No passing run is required: strength describes
// what a test WOULD prove, independent of coverage breadth (ledger.ts).

export type ClassifiedTier = StrictnessTier | 'unknown'

export interface ClassifiedAssertion {
  snippet: string
  tier: ClassifiedTier
}

// A real external destination (line.com, api.stripe.com, …) — NOT the app's own
// localhost, which is still the system reporting on itself (tier 3).
const EXTERNAL_URL = /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/i

const NETWORK = /(request|apicontext|fetch|axios|supertest|response)\b/
const NAVIGATION = /(page\.|frame\.|browser\.|goto|waitforurl)/
const UI_ASSERTION = /(page\.|locator|getbyrole|getbytext|getbytestid|tobevisible|tohavetext|tohaveurl|tohavevalue|tocontaintext)/

/**
 * Classify a single assertion/check snippet into a strictness tier by which
 * stack layer it touches. Strongest signal wins; conservative — returns
 * `unknown` rather than guess.
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

/**
 * Grade one test's coverage strength: the band of the strongest stack layer its
 * assertions touch. A test with no classifiable assertion falls to `shallow`
 * (we found nothing that proves depth).
 */
export function testStrengthFor(assertions: string[]): TestStrength {
  const tiers = classifyAssertions(assertions)
    .map((c) => c.tier)
    .filter((t): t is StrictnessTier => t !== 'unknown')
  const top = tiers.length ? (Math.max(...tiers) as StrictnessTier) : 1
  return top === 4 ? 'strong' : top === 3 ? 'solid' : top === 2 ? 'basic' : 'shallow'
}

export interface TestAssertions {
  name: string
  assertions: string[]
}

/** Augment a coverage ledger with per-test strength (depth). Breadth is untouched. */
export function applyTestStrength(ledger: CoverageLedger, testAssertions: TestAssertions[]): CoverageLedger {
  const byName = new Map(testAssertions.map((t) => [t.name, t.assertions]))
  const tests = ledger.tests.map((t) => ({
    ...t,
    strength: testStrengthFor(byName.get(t.name) ?? []),
  }))
  return { ...ledger, tests }
}
