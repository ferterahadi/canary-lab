import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyExternalSummary } from './feature-docs'
import { readPrdSummary } from './prd-summary'

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

describe('legacy requirement confirmation metadata', () => {
  it('reads an old summary without rewriting it and preserves IDs and source attribution on regeneration', () => {
    const featureDir = path.join(featuresDir, 'checkout')
    const file = path.join(featureDir, 'docs', '_prd-summary.json')
    const summary = readPrdSummary(featureDir)!
    const legacy = {
      ...summary,
      requirements: summary.requirements.map((r) => ({
        ...r, acceptedAt: '2026-09-02T00:00:00.000Z', acceptedFingerprint: r.fingerprint,
      })),
    }
    fs.writeFileSync(file, JSON.stringify(legacy))
    const before = fs.readFileSync(file, 'utf-8')
    expect(readPrdSummary(featureDir)).toEqual(legacy)
    expect(fs.readFileSync(file, 'utf-8')).toBe(before)

    applyExternalSummary({
      featuresDir, feature: 'checkout',
      requirements: [
        { id: 'R1', title: 'Totals add up', text: 'The total equals the sum of lines.', pathTypes: ['happy'] },
        { id: 'R2', title: 'Tax shown', text: 'Tax is shown as its own line.', pathTypes: ['happy'] },
      ],
      now: '2026-09-07T00:00:00.000Z',
    })
    const regenerated = readPrdSummary(featureDir)!
    expect(regenerated.requirements.map((r) => r.id)).toEqual(['R1', 'R2'])
    expect(regenerated.requirements[0].source).toEqual(summary.requirements[0].source)
    expect(regenerated.requirements[0].source?.doc).toBe('spec.md')
    for (const r of regenerated.requirements) {
      expect(r.wordingChangedAt).toBe('2026-09-01T00:00:00.000Z')
      expect(r.fingerprint).toBe(summary.requirements.find((old) => old.id === r.id)!.fingerprint)
      expect(r).not.toHaveProperty('acceptedAt')
      expect(r).not.toHaveProperty('acceptedFingerprint')
    }
  })
})
