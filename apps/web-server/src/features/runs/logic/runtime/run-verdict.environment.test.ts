import fs from 'fs'
import path from 'path'
import os from 'os'
import { afterAll, describe, expect, it } from 'vitest'
import { computeVerificationPlan, type SummaryShape } from './run-verdict'
import { classifyJournalOutcome } from './heal-journal'
import { normalizeRunCounts } from '../heal/external-heal-counts'
import type { RunSummary } from '../run-detail'

// Recorded after the 17 September repair: all failures cleared, but four
// environment gates remained skipped. Identities and paths are anonymized;
// the declared roster, counts and result relationships are preserved.
const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__/environment-summary.json'), 'utf8')) as RunSummary
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-environment-verdict-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function declared(): RunSummary {
  return {
    ...recorded, environment: 'local',
    environmentExclusions: recorded.skippedNames!.map((name, index) => ({
      id: recorded.skippedIds![index], name, environment: 'local', environments: ['meta'],
    })),
  }
}

describe('environment completion from recorded evidence', () => {
  it('keeps legacy skips incomplete and never calls zero failures all passed', () => {
    expect(computeVerificationPlan(dir, recorded as SummaryShape).kind).toBe('targeted')
    expect(classifyJournalOutcome({}, recorded)).toBe('failures_cleared')
  })

  it('settles declared environment exclusions without counting them as passes', () => {
    const summary = declared()
    expect(computeVerificationPlan(dir, summary as SummaryShape)).toEqual({ kind: 'all-passed', total: 55 })
    expect(classifyJournalOutcome({}, summary)).toBe('applicable_passed')
    expect(normalizeRunCounts(summary)).toMatchObject({
      totalKnown: 55, passed: 51, failed: 0, skipped: 4, notApplicable: 4, notRun: 0,
      statusLine: '51/55 passed, 0 failed, 4 skipped (4 outside this environment), 0 not run',
    })
  })

  it('does not pass a run consisting entirely of exclusions', () => {
    const summary = declared()
    summary.passed = 0
    summary.passedNames = []
    summary.passedIds = []
    summary.knownTests = summary.knownTests!.filter((test) => summary.skippedIds!.includes(test.id!))
    summary.total = 4
    expect(computeVerificationPlan(dir, summary).kind).toBe('full-suite')
    expect(classifyJournalOutcome({}, summary)).toBe('failures_cleared')
  })

  it.each(['serial-skip', 'not-run', 'wrong-environment', 'failed', 'unknown-id'])(
    'keeps %s evidence incomplete', (scenario) => {
      const summary = declared()
      if (scenario === 'serial-skip') summary.environmentExclusions!.pop()
      if (scenario === 'not-run') { summary.skippedNames = summary.skippedNames!.slice(1); summary.skippedIds = summary.skippedIds!.slice(1); summary.skipped = 3 }
      if (scenario === 'wrong-environment') summary.environment = 'meta'
      if (scenario === 'failed') summary.failed = [{ id: summary.skippedIds![0], name: summary.skippedNames![0] }]
      if (scenario === 'unknown-id') summary.environmentExclusions![0].id = 'not-in-roster'
      expect(computeVerificationPlan(dir, summary as SummaryShape).kind).toBe('targeted')
      expect(classifyJournalOutcome({}, summary)).not.toBe('applicable_passed')
      expect(classifyJournalOutcome({}, summary)).not.toBe('all_tests_passed')
    },
  )
})
