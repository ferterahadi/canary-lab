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

  it('omits the journal-awareness cue on cycle ≥ 2 when the journal file does not exist yet', () => {
    // First heal attempt of a run: cycle counter has advanced (the orchestrator
    // beginCycle()s before snapshotting + handing off to the agent) but no
    // prior iteration has been written. The cue must not lie about a journal
    // that isn't there — the agent would chase a phantom file.
    fs.mkdirSync(logsDir, { recursive: true })
    const addendum = buildHealAddendum({ cycle: 2 })

    expect(addendum).toContain('Cycle 2')
    expect(addendum).not.toContain('Prior iterations exist')
    expect(addendum).not.toContain('Skip hypotheses already tried')
  })

  it('uses the service-mode hard rule by default (no mode supplied)', () => {
    const addendum = buildHealAddendum({ cycle: 1 })
    expect(addendum).toContain('Do NOT Read the test spec file')
    expect(addendum).toContain('fix service/app code only')
    expect(addendum).not.toContain('Read the failing test spec')
  })

  it('uses the service-mode hard rule when mode is explicitly "service"', () => {
    const addendum = buildHealAddendum({ cycle: 1, mode: 'service' })
    expect(addendum).toContain('Do NOT Read the test spec file')
  })

  it('inverts the hard rule under test mode — agent is told to read the test spec', () => {
    const addendum = buildHealAddendum({ cycle: 1, mode: 'test' })
    expect(addendum).toContain('Read the failing test spec')
    expect(addendum).toContain('e2e/helpers/')
    expect(addendum).not.toContain('Do NOT Read the test spec file')
    expect(addendum).not.toContain('fix service/app code only')
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

  describe('stuck-cycle escalation', () => {
    // Threshold semantics:
    //   counter==1: first observation of this failure set — no prior fix
    //               attempt yet. No escalation.
    //   counter==2: second observation — one fix attempt failed. Could still
    //               be an honest miss, no escalation yet (avoid being premature).
    //   counter==3: third observation — two fix attempts failed. The agent is
    //               stuck; emit the escalation block.

    function seedFailingSummary(): void {
      fs.mkdirSync(logsDir, { recursive: true })
      fs.writeFileSync(summaryPath, JSON.stringify({ failed: [{ name: 'test-a' }, { name: 'test-b' }] }))
    }

    it('omits the escalation block when consecutiveSameFailures is 0 (fresh cycle, no streak)', () => {
      seedFailingSummary()
      const addendum = buildHealAddendum({ cycle: 1, consecutiveSameFailures: 0 })
      expect(addendum).not.toContain('Escalation:')
      expect(addendum).not.toContain('change tactic')
    })

    it('omits the escalation block when consecutiveSameFailures is 1 (first observation, no prior fix yet)', () => {
      seedFailingSummary()
      const addendum = buildHealAddendum({ cycle: 1, consecutiveSameFailures: 1 })
      expect(addendum).not.toContain('Escalation:')
    })

    it('omits the escalation block when consecutiveSameFailures is 2 (one fix attempt failed — give the agent one more shot)', () => {
      seedFailingSummary()
      const addendum = buildHealAddendum({ cycle: 2, consecutiveSameFailures: 2 })
      expect(addendum).not.toContain('Escalation:')
    })

    it('omits the escalation block when consecutiveSameFailures is undefined (caller did not plumb it in)', () => {
      seedFailingSummary()
      const addendum = buildHealAddendum({ cycle: 5 })
      expect(addendum).not.toContain('Escalation:')
    })

    it('omits the escalation block when there are no failing slugs (nothing to escalate about)', () => {
      // No summary on disk → readFailingSlugs returns [].
      const addendum = buildHealAddendum({ cycle: 3, consecutiveSameFailures: 3 })
      expect(addendum).not.toContain('Escalation:')
    })

    it('emits the escalation block at the threshold (consecutiveSameFailures === 3)', () => {
      seedFailingSummary()
      const failedDir = path.join(tmpRoot, 'logs', 'runs', 'r1', 'failed')
      const addendum = buildHealAddendum({
        cycle: 3,
        consecutiveSameFailures: 3,
        failedDir,
      })
      expect(addendum).toContain('Escalation: this is cycle 3 with the same failing set (test-a, test-b).')
      expect(addendum).toContain('change tactic, not double down')
      // Specific tactical bullets are present.
      expect(addendum).toContain('trace usually shows the real failure mode')
      expect(addendum).toContain('your last edit didn\'t help')
      expect(addendum).toContain('infra-flaky')
      expect(addendum).toContain('diagnostic logging or assertions')
    })

    it('continues emitting the escalation block above the threshold (counter === 5)', () => {
      seedFailingSummary()
      const addendum = buildHealAddendum({
        cycle: 5,
        consecutiveSameFailures: 5,
        failedDir: '/run/failed',
      })
      expect(addendum).toContain('Escalation:')
    })

    it('embeds absolute `failedDir/<slug>/trace-extract/...` paths so the agent can Read them directly', () => {
      seedFailingSummary()
      const failedDir = '/abs/path/logs/runs/r1/failed'
      const addendum = buildHealAddendum({
        cycle: 3,
        consecutiveSameFailures: 3,
        failedDir,
      })
      expect(addendum).toContain('/abs/path/logs/runs/r1/failed/<slug>/trace-extract/snapshot-at-failure.txt')
      expect(addendum).toContain('/abs/path/logs/runs/r1/failed/<slug>/trace-extract/network-failed.txt')
    })

    it('embeds the absolute journalPath in the prior-cycle-diff bullet', () => {
      seedFailingSummary()
      const runJournalPath = '/abs/path/logs/runs/r1/diagnosis-journal.md'
      const addendum = buildHealAddendum({
        cycle: 4,
        consecutiveSameFailures: 4,
        failedDir: '/abs/path/logs/runs/r1/failed',
        journalPath: runJournalPath,
      })
      expect(addendum).toContain(`Read the diff in \`${runJournalPath}\``)
    })

    it('falls back to <failedDir>/<slug>/... placeholders when failedDir is not plumbed in', () => {
      // Defensive fallback so the block still renders something useful if a
      // future caller forgets the path. Not the recommended path — but a
      // missing failedDir shouldn't crash addendum building.
      seedFailingSummary()
      const addendum = buildHealAddendum({ cycle: 3, consecutiveSameFailures: 3 })
      expect(addendum).toContain('<failedDir>/<slug>/trace-extract/snapshot-at-failure.txt')
    })

    it('references cycle N-1 as the prior cycle in the diff bullet', () => {
      seedFailingSummary()
      const addendum = buildHealAddendum({
        cycle: 7,
        consecutiveSameFailures: 5,
        failedDir: '/run/failed',
      })
      expect(addendum).toContain('changed `e2e/helpers/` in cycle 6')
    })

    it('coexists with the prior-iterations cue (escalation precedes journal cue in the output)', () => {
      seedFailingSummary()
      fs.writeFileSync(journalPath, '# Diagnosis Journal\n')
      const addendum = buildHealAddendum({
        cycle: 3,
        consecutiveSameFailures: 3,
        failedDir: '/run/failed',
      })
      const escalationIdx = addendum.indexOf('Escalation:')
      const journalIdx = addendum.indexOf('Prior iterations exist')
      expect(escalationIdx).toBeGreaterThan(-1)
      expect(journalIdx).toBeGreaterThan(-1)
      expect(escalationIdx).toBeLessThan(journalIdx)
    })
  })
})
