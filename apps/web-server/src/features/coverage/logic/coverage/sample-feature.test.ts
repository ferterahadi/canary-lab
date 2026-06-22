import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeFeatureCoverage } from './service'

// Pins the shipped `example_todo_api` sample: its annotations + PRD summary must
// produce the demo ledger so a future edit can't silently break the scaffold's
// demonstration. Semantic coverage is RUN-FREE — gap classes come purely from
// which @req/@path tags the specs carry, never from any run history.

const FEATURES_DIR = path.join(__dirname, '../../../../../../../templates/project/features')
const FEATURE = 'example_todo_api'

let logsDir: string

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sample-cov-')))
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

describe('example_todo_api sample coverage (run-free)', () => {
  it('demonstrates every gap class from the specs alone — no runs involved', () => {
    const ledger = computeFeatureCoverage({ featuresDir: FEATURES_DIR, logsDir, feature: FEATURE })
    const byId = Object.fromEntries(ledger.requirements.map((r) => [r.requirement.id, r]))

    // R1: happy is claimed but the PRD also declares a sad path that no test
    // claims → path-incomplete.
    expect(byId.R1.gapType).toBe('path-incomplete')
    // R2 + R3: every declared (happy) path is claimed by a mapped test → covered.
    expect(byId.R2.gapType).toBe('covered')
    expect(byId.R3.gapType).toBe('covered')
    // R4: no test maps to it → untested.
    expect(byId.R4.gapType).toBe('untested')

    expect(ledger.totals).toMatchObject({ total: 4, covered: 2, pathIncomplete: 1, untested: 1 })
    expect(ledger.docsDrift).toBe(false) // shipped summary hash matches prd.md
  })
})
