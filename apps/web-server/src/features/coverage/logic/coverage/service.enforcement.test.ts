import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyExternalSummary } from './feature-docs'
import { computeFeatureCoverage } from './service'

// The time axis (D11) rides the single ledger computation: computeFeatureCoverage
// joins the run records (index + summaries + manifests) to the requirements the
// current @requirement tags map, so both the UI and get_feature_coverage read
// the same states. Real feature dir, real logs dir.

let tmp: string
let featuresDir: string
let logsDir: string
const dir = (): string => path.join(featuresDir, 'checkout')

const SPEC = `
  import { test, expect } from '@playwright/test'
  // @requirement R1
  // @path happy
  test('totals add up', async () => {
    await expect(page.locator('.total')).toHaveText('10')
  })
`

function seedRun(runId: string, startedAt: string, passedNames: string[], manifestExtra: Record<string, unknown> = {}): void {
  const runDir = path.join(logsDir, 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const indexPath = path.join(logsDir, 'runs', 'index.json')
  const index = fs.existsSync(indexPath) ? (JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as unknown[]) : []
  index.push({ runId, feature: 'checkout', startedAt, status: 'passed' })
  fs.writeFileSync(indexPath, JSON.stringify(index))
  fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({ passedNames, failed: [] }))
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    runId, feature: 'checkout', startedAt, status: 'passed', healCycles: 0, services: [], ...manifestExtra,
  }))
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-enf-')))
  featuresDir = path.join(tmp, 'features')
  logsDir = path.join(tmp, 'logs')
  fs.mkdirSync(path.join(dir(), 'docs'), { recursive: true })
  fs.mkdirSync(path.join(dir(), 'e2e'), { recursive: true })
  fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true })
  fs.writeFileSync(
    path.join(dir(), 'feature.config.cjs'),
    `module.exports = { config: { name: 'checkout', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  fs.writeFileSync(path.join(dir(), 'docs', 'spec.md'), '# Checkout\n\n## Totals\nThe total equals the sum of lines.\n')
  fs.writeFileSync(path.join(dir(), 'e2e', 'a.spec.ts'), SPEC)
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('computeFeatureCoverage — the time axis', () => {
  it('a requirement proven by a run newer than its wording reads proven-unchanged, with the header roll-up', () => {
    applyExternalSummary({
      featuresDir, feature: 'checkout',
      requirements: [
        { title: 'Totals add up', text: 'The total equals the sum of lines.', pathTypes: ['happy'] },
        { title: 'Tax shown', text: 'Tax is its own line.', pathTypes: ['happy'] },
      ],
      now: '2026-09-01T00:00:00.000Z',
    })
    seedRun('r1', '2026-09-02T00:00:00.000Z', ['test-case-totals-add-up'])
    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    const byId = new Map(ledger.requirements.map((rc) => [rc.requirement.id, rc]))
    expect(byId.get('R1')!.enforcement).toMatchObject({
      state: 'proven-unchanged',
      provenAt: { runId: 'r1', at: '2026-09-02T00:00:00.000Z' },
      wordingChangedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(byId.get('R2')!.enforcement?.state).toBe('wording-ahead')
    expect(ledger.enforcement).toEqual({
      runId: 'r1', provenUnchanged: 1, total: 2,
      states: { 'proven-unchanged': 1, 'tests-weakened': 0, 'wording-ahead': 1, 'proof-stale': 0 },
    })
    // Additive: the proven axis and the claim axis are what they were.
    expect(ledger.provenRunId).toBe('r1')
    expect(ledger.coveragePct).toBe(50)
  })

  it('a weaker spec edit recorded by a run after the proof flips the requirement to tests-weakened', () => {
    applyExternalSummary({
      featuresDir, feature: 'checkout',
      requirements: [{ title: 'Totals add up', text: 'The total equals the sum of lines.', pathTypes: ['happy'] }],
      now: '2026-09-01T00:00:00.000Z',
    })
    seedRun('r1', '2026-09-02T00:00:00.000Z', ['test-case-totals-add-up'])
    seedRun('r2', '2026-09-03T00:00:00.000Z', [], {
      specEdits: {
        checkedAt: '2026-09-03T00:05:00.000Z',
        pending: [{
          file: 'e2e/a.spec.ts', affectedTests: ['totals add up'], change: 'modified',
          strength: { baseline: 'run-start', verdict: 'weaker', tests: [{ kind: 'changed', name: 'totals add up', verdict: 'weaker', changes: [] }] },
        }],
        adopted: [],
      },
    })
    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    expect(ledger.requirements[0].enforcement).toMatchObject({
      state: 'tests-weakened',
      provenAt: { runId: 'r1' },
      testsChangedAt: { at: '2026-09-03T00:05:00.000Z', tests: ['totals add up'], verdict: 'weaker', runId: 'r2' },
    })
    expect(ledger.enforcement?.runId).toBe('r2')
  })

  it('a feature without a summary carries no time axis', () => {
    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    expect(ledger.enforcement).toBeUndefined()
    expect(ledger.requirements).toEqual([])
  })
})
