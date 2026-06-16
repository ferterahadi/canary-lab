import { describe, it, expect } from 'vitest'
import type { Requirement } from '../../../../shared/coverage/types'
import type { LastPassingRun, PassingRunIndex } from './grounding'
import { computeCoverageLedger, type CoverageTestInput } from './ledger'
import { applyRigor, classifyAssertionTier, type TestAssertions } from './rigor'

describe('classifyAssertionTier', () => {
  it('tier 4 — browser drives the real external destination', () => {
    expect(classifyAssertionTier("await page.goto('https://line.com/inbox')")).toBe(4)
    expect(classifyAssertionTier("await expect(page).toHaveURL('https://line.com/ok')")).toBe(4)
    expect(classifyAssertionTier("const r = await request.get('https://api.line.me/v2/bot')")).toBe(4)
  })

  it('tier 3 — internal API response or a UI assertion on the app page', () => {
    expect(classifyAssertionTier("expect(response.status()).toBe(200)")).toBe(3)
    expect(classifyAssertionTier("await expect(page.getByRole('alert')).toBeVisible()")).toBe(3)
    expect(classifyAssertionTier("await expect(page.locator('.toast')).toHaveText('Sent')")).toBe(3)
  })

  it('tier 2 — internal state via DB / ORM / fixture', () => {
    expect(classifyAssertionTier("const row = await prisma.message.findFirst({ where: { id } })")).toBe(2)
    expect(classifyAssertionTier("const r = await db.query('select * from outbox')")).toBe(2)
  })

  it('tier 1 — the app log / a file it wrote', () => {
    expect(classifyAssertionTier("const log = fs.readFileSync('app.log','utf-8')")).toBe(1)
    expect(classifyAssertionTier("const out = await fs.promises.readFile('server.log','utf8')")).toBe(1)
    expect(classifyAssertionTier("expect(console.log).toHaveBeenCalledWith('message sent')")).toBe(1)
  })

  it('unknown — no confident structural signal (no var-name guessing)', () => {
    expect(classifyAssertionTier('expect(total).toBe(42)')).toBe('unknown')
    expect(classifyAssertionTier('const x = helper()')).toBe('unknown')
    // a var merely *named* consoleOutput is not a structural log signal
    expect(classifyAssertionTier("expect(consoleOutput).toContain('sent')")).toBe('unknown')
  })
})

// --- grounded scoring -------------------------------------------------------

function req(id: string, ladderMax?: number): Requirement {
  return {
    id,
    title: id,
    text: `${id}`,
    pathTypes: ['happy'],
    strictnessLadder: ladderMax
      ? Array.from({ length: ladderMax }, (_, i) => ({ tier: (i + 1) as 1 | 2 | 3 | 4, description: `tier ${i + 1}` }))
      : undefined,
  }
}

function indexOf(...names: string[]): PassingRunIndex {
  const byTestName = new Map<string, LastPassingRun>()
  for (const n of names) byTestName.set(n, { testName: n, runId: `r-${n}`, at: '2026-01-01' })
  return { byTestName }
}

function ledgerFor(requirements: Requirement[], tests: CoverageTestInput[], index: PassingRunIndex) {
  return computeCoverageLedger({ feature: 'f', requirements, tests, index })
}

describe('applyRigor — grounded strictness', () => {
  it('lax-but-passing → shallow-verified with a feedback payload', () => {
    const requirements = [req('R1', 4)] // ladder tops out at tier 4
    const tests: CoverageTestInput[] = [{ name: 'send msg', requirements: ['R1'], pathTypes: ['happy'] }]
    const assertions: TestAssertions[] = [{ name: 'send msg', assertions: ["expect(fs.readFileSync('app.log')).toContain('sent')"] }]
    const base = ledgerFor(requirements, tests, indexOf('send msg'))
    expect(base.requirements[0].gapType).toBe('verified')

    const out = applyRigor(base, requirements, assertions)
    const r = out.requirements[0]
    expect(r.gapType).toBe('shallow-verified')
    expect(r.rigor).toMatchObject({ tierReached: 1, tierAvailable: 4, strictness: 0.25 })
    expect(r.rigor?.weakestAssertion).toContain('app.log')
    expect(r.rigor?.suggestedStrongerCheck).toBe('tier 4')
    expect(out.totals.shallowVerified).toBe(1)
    // breadth % unchanged — shallow is still covered by a passing run
    expect(out.totals.verified).toBe(1)
    expect(out.coveragePct).toBe(100)
  })

  it('strict (reaches ladder max) → stays verified', () => {
    const requirements = [req('R1', 4)]
    const tests: CoverageTestInput[] = [{ name: 'send msg', requirements: ['R1'], pathTypes: ['happy'] }]
    const assertions: TestAssertions[] = [{ name: 'send msg', assertions: ["await page.goto('https://line.com/inbox')", "await expect(page.locator('.msg')).toBeVisible()"] }]
    const out = applyRigor(ledgerFor(requirements, tests, indexOf('send msg')), requirements, assertions)
    expect(out.requirements[0].gapType).toBe('verified')
    expect(out.requirements[0].rigor).toMatchObject({ tierReached: 4, tierAvailable: 4, strictness: 1 })
    expect(out.totals.shallowVerified).toBe(0)
  })

  it('strong tier exists but only the weak test passed → shallow (grounded on passing run)', () => {
    const requirements = [req('R1', 4)]
    const tests: CoverageTestInput[] = [
      { name: 'weak log check', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 'strong browser check', requirements: ['R1'], pathTypes: ['happy'] },
    ]
    const assertions: TestAssertions[] = [
      { name: 'weak log check', assertions: ["expect(fs.readFileSync('app.log')).toContain('sent')"] },
      { name: 'strong browser check', assertions: ["await page.goto('https://line.com')"] },
    ]
    // Only the weak test has a passing run; the strong one never passed.
    const out = applyRigor(ledgerFor(requirements, tests, indexOf('weak log check')), requirements, assertions)
    expect(out.requirements[0].gapType).toBe('shallow-verified')
    expect(out.requirements[0].rigor?.tierReached).toBe(1)
  })

  it('no ladder → no shallow flag (cannot ground the ceiling), strictness undefined', () => {
    const requirements = [req('R1')] // no strictnessLadder
    const tests: CoverageTestInput[] = [{ name: 't', requirements: ['R1'], pathTypes: ['happy'] }]
    const assertions: TestAssertions[] = [{ name: 't', assertions: ["expect(fs.readFileSync('app.log')).toContain('x')"] }]
    const out = applyRigor(ledgerFor(requirements, tests, indexOf('t')), requirements, assertions)
    expect(out.requirements[0].gapType).toBe('verified')
    expect(out.requirements[0].rigor?.tierReached).toBe(1)
    expect(out.requirements[0].rigor?.strictness).toBeUndefined()
  })

  it('leaves unverified / untested requirements untouched (rigor needs ground truth)', () => {
    const requirements = [req('R1', 4)]
    const tests: CoverageTestInput[] = [{ name: 't', requirements: ['R1'], pathTypes: ['happy'] }]
    const assertions: TestAssertions[] = [{ name: 't', assertions: ["await page.goto('https://line.com')"] }]
    const out = applyRigor(ledgerFor(requirements, tests, indexOf(/* nothing passed */)), requirements, assertions)
    expect(out.requirements[0].gapType).toBe('unverified')
    expect(out.requirements[0].rigor).toBeUndefined()
  })
})
