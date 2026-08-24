import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeFeatureCoverage } from '../apps/web-server/src/features/coverage/logic/coverage/service'
import { readDocsCollection } from '../apps/web-server/src/features/coverage/logic/coverage/docs-collection'
import { readPrdSummary } from '../apps/web-server/src/features/coverage/logic/coverage/prd-summary-render'
import { COLLECTED_DOC_NAME, REQUIREMENTS, SOURCE_DOC } from './gen-workflow-workbench-prd-summary'

const FEATURES_DIR = path.join(__dirname, '..', 'templates', 'project', 'features')
const FEATURE = 'workflow-workbench'
const FEATURE_DIR = path.join(FEATURES_DIR, FEATURE)

describe('shipped workflow-workbench PRD summary', () => {
  it('is generated from the product repository requirements', () => {
    expect(fs.readFileSync(path.join(FEATURE_DIR, 'docs', COLLECTED_DOC_NAME), 'utf-8'))
      .toBe(fs.readFileSync(SOURCE_DOC, 'utf-8'))
    const summary = readPrdSummary(FEATURE_DIR)
    expect(summary?.docsHash).toBe(readDocsCollection(FEATURE_DIR).docsHash)
    expect(summary?.requirements.map((requirement) => requirement.id))
      .toEqual(REQUIREMENTS.map((requirement) => requirement.id))
  })

  it('ships one unlinked test and two requirements ready for mapping', () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-workbench-cov-'))
    try {
      const ledger = computeFeatureCoverage({ featuresDir: FEATURES_DIR, logsDir, feature: FEATURE })
      expect(ledger.coveragePct).toBe(0)
      expect(ledger.totals.untested).toBe(2)
      expect(ledger.requirements.find((entry) => entry.requirement.id === 'R1')?.gapType).toBe('untested')
      expect(ledger.requirements.find((entry) => entry.requirement.id === 'R2')?.gapType).toBe('untested')
      expect(ledger.totals.orphanTests).toBe(1)
      expect(ledger.state).toMatchObject({ coverage: 'absent', headline: 'No coverage' })
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true })
    }
  })
})
