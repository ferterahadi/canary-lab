import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeFeatureCoverage } from '../apps/web-server/src/features/coverage/logic/coverage/service'
import { readDocsCollection } from '../apps/web-server/src/features/coverage/logic/coverage/docs-collection'
import { readPrdSummary } from '../apps/web-server/src/features/coverage/logic/coverage/prd-summary-render'
import { COLLECTED_DOC_NAME, REQUIREMENTS, SOURCE_DOC } from './gen-storefront-prd-summary'

// The shipped storefront_journey suite claims a satisfied Requirements stage and
// full requirement coverage the moment `init` lands it. Both claims are made by
// COMMITTED artifacts, so nothing at runtime would catch them going stale —
// these are the checks that do. A failure here means: run `npm run gen:demo-prd`.

const FEATURES_DIR = path.join(__dirname, '..', 'templates', 'project', 'features')
const FEATURE = 'storefront_journey'
const FEATURE_DIR = path.join(FEATURES_DIR, FEATURE)

describe('shipped storefront_journey PRD summary', () => {
  it('collected the product repo\'s requirements doc verbatim', () => {
    expect(fs.readFileSync(path.join(FEATURE_DIR, 'docs', COLLECTED_DOC_NAME), 'utf-8'))
      .toBe(fs.readFileSync(SOURCE_DOC, 'utf-8'))
  })

  it('is not drifted from the doc it was generated from', () => {
    const summary = readPrdSummary(FEATURE_DIR)
    expect(summary).not.toBeNull()
    expect(summary!.docsHash).toBe(readDocsCollection(FEATURE_DIR).docsHash)
    expect(summary!.sourceDocs).toEqual([COLLECTED_DOC_NAME])
  })

  it('ships every requirement the generator declares', () => {
    const summary = readPrdSummary(FEATURE_DIR)!
    expect(summary.requirements.map((r) => r.id)).toEqual(REQUIREMENTS.map((r) => r.id))
    for (const r of summary.requirements) expect(r.fingerprint).toBeTruthy()
  })

  it('reads 100% coverage with no orphan tests, straight from the template', () => {
    // The ledger reaches for a runs index that a bare template has none of;
    // point it at an empty logs dir so the claim-based math is what's measured.
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-shipped-cov-'))
    try {
      const ledger = computeFeatureCoverage({ featuresDir: FEATURES_DIR, logsDir, feature: FEATURE })
      expect(ledger.totals.total).toBe(REQUIREMENTS.length)
      expect(ledger.coveragePct).toBe(100)
      expect(ledger.totals.untested).toBe(0)
      expect(ledger.totals.pathIncomplete).toBe(0)
      expect(ledger.totals.orphanTests).toBe(0)
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true })
    }
  })

  it('maps all seven journeys — every requirement is claimed by a real test', () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-shipped-cov-'))
    try {
      const ledger = computeFeatureCoverage({ featuresDir: FEATURES_DIR, logsDir, feature: FEATURE })
      expect(ledger.tests).toHaveLength(7)
      for (const r of ledger.requirements) {
        expect(r.annotatedTestNames.length, `${r.requirement.id} has no test`).toBeGreaterThan(0)
      }
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true })
    }
  })
})
