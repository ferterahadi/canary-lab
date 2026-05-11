import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-hpb-')))
const logsDir = path.join(tmpRoot, 'logs')
const summaryPath = path.join(logsDir, 'e2e-summary.json')
const journalPath = path.join(logsDir, 'diagnosis-journal.md')

vi.mock('./paths', () => ({
  DIAGNOSIS_JOURNAL_PATH: journalPath,
  getSummaryPath: () => summaryPath,
}))

const { buildHealAddendum } = await import('./heal-prompt-builder')

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

describe('buildHealAddendum', () => {
  it('omits optional cycle and failure details when no summary exists', () => {
    const addendum = buildHealAddendum({ cycle: 1 })
    expect(addendum).toContain('Cycle 1.')
    expect(addendum).not.toContain('Failing tests:')
    expect(addendum).not.toContain('Prior iterations exist')
  })

  it('includes max cycle, failed slugs, and journal guidance after the first cycle', () => {
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        failed: [{ name: 'test-case-a' }, { name: 123 }, {}, { name: 'test-case-b' }],
      }),
    )
    fs.writeFileSync(journalPath, '# Diagnosis Journal\n')

    const addendum = buildHealAddendum({ cycle: 2, maxCycles: 3 })

    expect(addendum).toContain('Cycle 2 of 3. Failing tests: test-case-a, test-case-b.')
    expect(addendum).toContain('Prior iterations exist in this run')
  })

  it('uses an explicit run-local journal path for prior-iteration guidance', () => {
    const runJournalPath = path.join(logsDir, 'runs', 'r1', 'diagnosis-journal.md')
    fs.mkdirSync(path.dirname(runJournalPath), { recursive: true })
    fs.writeFileSync(runJournalPath, '# Diagnosis Journal\n')

    const addendum = buildHealAddendum({ cycle: 2, journalPath: runJournalPath })

    expect(addendum).toContain('Prior iterations exist in this run')
  })

  it('ignores summaries without a failed array', () => {
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(summaryPath, JSON.stringify({ failed: 'not-an-array' }))

    const addendum = buildHealAddendum({ cycle: 1, maxCycles: 2 })

    expect(addendum).toContain('Cycle 1 of 2.')
    expect(addendum).not.toContain('Failing tests:')
  })

  it('asks the agent for hypothesis and fixDescription only, not filesChanged', () => {
    // The new signal-body contract drops filesChanged (the runner observes it
    // via git) and adds fixDescription. The addendum must match the static
    // prompt so the agent sees a consistent schema.
    const addendum = buildHealAddendum({ cycle: 1 })

    expect(addendum).toContain('hypothesis')
    expect(addendum).toContain('fixDescription')
    expect(addendum).toContain('runner detects which files you changed via git')
    expect(addendum).not.toContain('filesChanged')
    // Sanity check on the JSON example shape.
    expect(addendum).toContain('{"hypothesis":"…","fixDescription":"…"}')
  })

  it('drops the cycle-≥2 patch-outcome instruction but keeps the "skip tried hypotheses" cue', () => {
    // The reporter's reconcileJournalOutcome patches `outcome: pending`
    // deterministically on onEnd, so telling the agent to do it is dead
    // weight. The remaining cue is the journal-awareness flag that the
    // static prompt depends on.
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(journalPath, '# Diagnosis Journal\n')

    const addendum = buildHealAddendum({ cycle: 2 })

    expect(addendum).toContain('Prior iterations exist')
    expect(addendum).toContain('Skip hypotheses already tried')
    // None of the patch-outcome text should remain.
    expect(addendum).not.toContain('outcome: pending')
    expect(addendum).not.toContain('all_passed')
    expect(addendum).not.toContain('regression')
    expect(addendum).not.toContain('Before forming a new hypothesis')
  })
})
