import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeRunsIndex } from '../../../runs/logic/runtime/manifest'
import { buildRunPaths, runDirFor } from '../../../runs/logic/runtime/run-paths'
import { computeFeatureCoverage } from './service'

// Pins the shipped `example_todo_api` sample: its annotations + PRD summary must
// produce the demo ledger (every gap type, incl. shallow-verified) so a future
// edit can't silently break the scaffold's demonstration. Uses the REAL template
// feature dir + a fabricated run history (the equivalent of "after a passing run").

const FEATURES_DIR = path.join(__dirname, '../../../../../../../templates/project/features')
const FEATURE = 'example_todo_api'

// The test names that, when passing, exercise each requirement (from the two
// shipped specs). The rigor-demo spec carries the tier-3 assertions.
const PASSING = [
  'POST /todos creates a todo',
  'GET /todos lists todos',
  'DELETE /todos/:id removes a todo',
  'create is confirmed by an independent read (tier 3)',
  'delete is confirmed via the app API (tier 3, not the UI)',
]

let logsDir: string

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sample-cov-')))
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

function writePassingRun(passedNames: string[]) {
  writeRunsIndex(logsDir, [{ runId: 'r1', feature: FEATURE, startedAt: '2026-06-16T00:00:00Z', status: 'passed' as never }])
  const runDir = runDirFor(logsDir, 'r1')
  fs.mkdirSync(runDir, { recursive: true })
  const paths = buildRunPaths(runDir)
  fs.writeFileSync(paths.manifestPath, JSON.stringify({ runId: 'r1', feature: FEATURE, env: 'local', startedAt: '2026-06-16T00:00:00Z', status: 'passed', services: [] }))
  fs.writeFileSync(paths.summaryPath, JSON.stringify({ complete: true, total: passedNames.length, passed: passedNames.length, passedNames, failed: [] }))
}

describe('example_todo_api sample coverage', () => {
  it('before any run, every annotated requirement is unverified and R4 is untested', () => {
    const ledger = computeFeatureCoverage({ featuresDir: FEATURES_DIR, logsDir, feature: FEATURE })
    const byId = Object.fromEntries(ledger.requirements.map((r) => [r.requirement.id, r]))
    expect(byId.R1.gapType).toBe('unverified')
    expect(byId.R2.gapType).toBe('unverified')
    expect(byId.R3.gapType).toBe('unverified')
    expect(byId.R4.gapType).toBe('untested')
    expect(ledger.coveragePct).toBe(0)
    expect(ledger.docsDrift).toBe(false) // shipped summary hash matches prd.md
  })

  it('after a passing run, demonstrates all four gap classes incl. shallow-verified', () => {
    writePassingRun(PASSING)
    const ledger = computeFeatureCoverage({ featuresDir: FEATURES_DIR, logsDir, feature: FEATURE })
    const byId = Object.fromEntries(ledger.requirements.map((r) => [r.requirement.id, r]))

    // R1: happy verified but the PRD also implies a sad path → path-incomplete.
    expect(byId.R1.gapType).toBe('path-incomplete')
    // R2: happy verified, ladder ceiling (tier 3) reached → verified.
    expect(byId.R2.gapType).toBe('verified')
    // R3: passes via the API (tier 3) but the ladder tops out at a browser
    // confirmation (tier 4) → shallow-verified, with a suggested stronger check.
    expect(byId.R3.gapType).toBe('shallow-verified')
    expect(byId.R3.rigor?.tierReached).toBe(3)
    expect(byId.R3.rigor?.tierAvailable).toBe(4)
    expect(byId.R3.rigor?.suggestedStrongerCheck).toContain('browser')
    // R4: no annotated test at all → untested.
    expect(byId.R4.gapType).toBe('untested')

    expect(ledger.totals).toMatchObject({ total: 4, untested: 1, shallowVerified: 1, pathIncomplete: 1 })
  })
})
