import { describe, it, expect } from 'vitest'
import type { Requirement } from '../../../../../../../shared/coverage/types'
import { computeCoverageLedger, type CoverageTestInput } from './ledger'
import { applyTestStrength, classifyAssertionTier, testStrengthFor, type TestAssertions } from './strength'

describe('classifyAssertionTier', () => {
  it('tier 4 — browser drives the real external destination', () => {
    expect(classifyAssertionTier("await page.goto('https://line.com/inbox')")).toBe(4)
    expect(classifyAssertionTier("await expect(page).toHaveURL('https://line.com/ok')")).toBe(4)
    expect(classifyAssertionTier("const r = await request.get('https://api.line.me/v2/bot')")).toBe(4)
  })

  it('tier 3 — internal API response or a UI assertion on the app page', () => {
    expect(classifyAssertionTier('expect(response.status()).toBe(200)')).toBe(3)
    expect(classifyAssertionTier("await expect(page.getByRole('alert')).toBeVisible()")).toBe(3)
  })

  it('tier 2 — internal state via DB / ORM / fixture', () => {
    expect(classifyAssertionTier('const row = await prisma.message.findFirst({ where: { id } })')).toBe(2)
    expect(classifyAssertionTier("const r = await db.query('select * from outbox')")).toBe(2)
  })

  it('tier 1 — the app log / a file it wrote', () => {
    expect(classifyAssertionTier("const log = fs.readFileSync('app.log','utf-8')")).toBe(1)
    expect(classifyAssertionTier("expect(console.log).toHaveBeenCalledWith('message sent')")).toBe(1)
  })

  it('unknown — no confident structural signal', () => {
    expect(classifyAssertionTier('expect(total).toBe(42)')).toBe('unknown')
    expect(classifyAssertionTier("expect(consoleOutput).toContain('sent')")).toBe('unknown')
  })
})

describe('testStrengthFor — run-free depth band', () => {
  it('grades by the strongest classifiable assertion tier', () => {
    expect(testStrengthFor(["await page.goto('https://line.com/inbox')"])).toBe('strong')
    expect(testStrengthFor(['expect(response.status()).toBe(200)'])).toBe('solid')
    expect(testStrengthFor(['const row = await prisma.user.findFirst()'])).toBe('basic')
    expect(testStrengthFor(["fs.readFileSync('app.log')"])).toBe('shallow')
  })

  it('falls back to shallow when no assertion classifies (no run gate)', () => {
    expect(testStrengthFor(['expect(total).toBe(42)'])).toBe('shallow')
    expect(testStrengthFor([])).toBe('shallow')
  })
})

describe('applyTestStrength — attaches per-test strength to the ledger', () => {
  it('grades each test from its own assertions, regardless of runs', () => {
    const req = (id: string): Requirement => ({ id, title: id, text: id, pathTypes: ['happy'] })
    const tests: CoverageTestInput[] = [
      { name: 'strong t', requirements: ['R1'], pathTypes: ['happy'] },
      { name: 'shallow t', requirements: ['R2'], pathTypes: ['happy'] },
    ]
    const assertions: TestAssertions[] = [
      { name: 'strong t', assertions: ["await page.goto('https://line.com/inbox')"] },
      { name: 'shallow t', assertions: ["fs.readFileSync('app.log')"] },
    ]
    const ledger = applyTestStrength(computeCoverageLedger({ feature: 'f', requirements: [req('R1'), req('R2')], tests }), assertions)
    const byName = new Map(ledger.tests.map((t) => [t.name, t.strength]))
    expect(byName.get('strong t')).toBe('strong')
    expect(byName.get('shallow t')).toBe('shallow')
  })
})
