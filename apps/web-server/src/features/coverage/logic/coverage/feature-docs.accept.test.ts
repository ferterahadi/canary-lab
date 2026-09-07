import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FeatureNotFoundError } from './service'
import { acceptRequirementWording, applyExternalSummary } from './feature-docs'
import { readPrdSummary } from './prd-summary'

// Requirement acceptance (D11): a HUMAN marks a requirement's wording accepted
// from the ledger. The mark is a fingerprint, so the ledger can later say
// "accepted wording is older than the current wording" instead of forgetting.
// UI route only — no MCP tool wraps it (pinned by mcp/repair-guardrail.test.ts).

let tmp: string
let featuresDir: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-accept-')))
  featuresDir = path.join(tmp, 'features')
  const dir = path.join(featuresDir, 'checkout')
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: 'checkout', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Checkout\n\n## Totals\nThe total equals the sum of lines.\n')
  applyExternalSummary({
    featuresDir,
    feature: 'checkout',
    requirements: [
      { title: 'Totals add up', text: 'The total equals the sum of lines.', pathTypes: ['happy'] },
      { title: 'Tax shown', text: 'Tax is shown as its own line.', pathTypes: ['happy'] },
    ],
    now: '2026-09-01T00:00:00.000Z',
  })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('acceptRequirementWording', () => {
  it('stamps acceptedAt and the accepted fingerprint onto the stored requirement', () => {
    const result = acceptRequirementWording({ featuresDir, feature: 'checkout', requirementId: 'R1', now: '2026-09-07T10:00:00.000Z' })
    const stored = readPrdSummary(path.join(featuresDir, 'checkout'))!.requirements[0]
    expect(result).toEqual({ feature: 'checkout', requirementId: 'R1', acceptedAt: '2026-09-07T10:00:00.000Z', acceptedFingerprint: stored.fingerprint })
    expect(stored.acceptedAt).toBe('2026-09-07T10:00:00.000Z')
    expect(stored.acceptedFingerprint).toBe(stored.fingerprint)
    // The sibling requirement is untouched — acceptance is per requirement.
    const sibling = readPrdSummary(path.join(featuresDir, 'checkout'))!.requirements[1]
    expect(sibling.id).toBe('R2')
    expect(sibling.acceptedAt).toBeUndefined()
  })

  it('re-accepting after a wording change moves the mark to the new fingerprint', () => {
    acceptRequirementWording({ featuresDir, feature: 'checkout', requirementId: 'R1', now: '2026-09-07T10:00:00.000Z' })
    const before = readPrdSummary(path.join(featuresDir, 'checkout'))!.requirements[0]
    applyExternalSummary({
      featuresDir,
      feature: 'checkout',
      requirements: [{ id: 'R1', title: 'Totals add up', text: 'The total equals the sum of lines plus tax.', pathTypes: ['happy'] }],
      now: '2026-09-08T00:00:00.000Z',
    })
    const drifted = readPrdSummary(path.join(featuresDir, 'checkout'))!.requirements[0]
    expect(drifted.acceptedFingerprint).toBe(before.fingerprint)
    expect(drifted.fingerprint).not.toBe(drifted.acceptedFingerprint)

    acceptRequirementWording({ featuresDir, feature: 'checkout', requirementId: 'R1', now: '2026-09-09T00:00:00.000Z' })
    const again = readPrdSummary(path.join(featuresDir, 'checkout'))!.requirements[0]
    expect(again.acceptedFingerprint).toBe(again.fingerprint)
    expect(again.acceptedAt).toBe('2026-09-09T00:00:00.000Z')
  })

  it('a pre-D11 summary without stored fingerprints is accepted on a freshly computed one, stamped now', () => {
    const file = path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json')
    const legacy = JSON.parse(fs.readFileSync(file, 'utf-8')) as { requirements: Array<Record<string, unknown>> }
    for (const r of legacy.requirements) delete r.fingerprint
    fs.writeFileSync(file, JSON.stringify(legacy))
    const before = Date.now()
    const result = acceptRequirementWording({ featuresDir, feature: 'checkout', requirementId: 'R1' })
    expect(result.acceptedFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(result.acceptedAt)).toBeGreaterThanOrEqual(before)
  })

  it('rejects an unknown requirement id with a 404-shaped error and writes nothing', () => {
    const before = fs.readFileSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), 'utf-8')
    expect(() => acceptRequirementWording({ featuresDir, feature: 'checkout', requirementId: 'R9' }))
      .toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), 'utf-8')).toBe(before)
  })

  it('rejects a feature with no summary, and an unknown feature', () => {
    fs.rmSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'))
    expect(() => acceptRequirementWording({ featuresDir, feature: 'checkout', requirementId: 'R1' }))
      .toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => acceptRequirementWording({ featuresDir, feature: 'nope', requirementId: 'R1' }))
      .toThrow(FeatureNotFoundError)
  })
})
