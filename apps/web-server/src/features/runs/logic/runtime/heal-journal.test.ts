import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MAX_JOURNAL_DIFF_BYTES, classifyJournalOutcome, countConsecutiveSameFailures, nextIterationNumber, parseJournalMarkdown, stuckSlugsFromJournal, truncateDiffForJournal, updateLatestPendingJournalOutcome, writeFullDiffPatch } from './heal-journal'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-le-')))
})

describe('parseJournalMarkdown', () => {
  it('extracts run, feature, hypothesis, signal, outcome, and fix.* fields', () => {
    const md = `## Iteration 1 — 2026-04-28T10:15:00Z

- run: 2026-04-28T1015-abc1
- feature: demo
- failingTests: a-test
- hypothesis: it's broken
- fix.file: /tmp/x.ts
- fix.description: changed thing
- signal: .restart
- outcome: pending

## Iteration 2 — 2026-04-28T10:16:00Z

- run: 2026-04-28T1016-def2
- hypothesis: still broken
- outcome: no_change
`
    const entries = parseJournalMarkdown(md)
    expect(entries).toHaveLength(2)
    expect(entries[0].run).toBe('2026-04-28T1015-abc1')
    expect(entries[0].feature).toBe('demo')
    expect(entries[0].failingTests).toBe('a-test')
    expect(entries[0].fix?.file).toBe('/tmp/x.ts')
    expect(entries[0].fix?.description).toBe('changed thing')
    expect(entries[0].outcome).toBeNull()
    expect(entries[1].outcome).toBe('no_change')
  })

  it('returns empty array for non-journal text', () => {
    expect(parseJournalMarkdown('not a journal')).toEqual([])
  })

  it('sets fix.description without a preceding fix.file and ignores unrecognized field keys', () => {
    // fix.description arrives with no fix.file before it, so `current.fix` is
    // still undefined and the parser must seed a fresh `{}` for it. A field
    // line whose key matches none of the known fields (customKey) must be
    // silently dropped rather than attached to the entry.
    const md = `## Iteration 1 — 2026-04-28T10:15:00Z

- hypothesis: broke
- fix.description: only a description, no fix.file here
- customKey: this key is not recognized
- signal: .restart
- outcome: pending
`
    const entries = parseJournalMarkdown(md)
    expect(entries).toHaveLength(1)
    // fix seeded from scratch — no file field, only the description.
    expect(entries[0].fix).toEqual({ description: 'only a description, no fix.file here' })
    expect(entries[0].hypothesis).toBe('broke')
    expect(entries[0].signal).toBe('.restart')
    // The unrecognized field produced no property on the entry.
    expect((entries[0] as unknown as Record<string, unknown>).customKey).toBeUndefined()
  })
})

describe('countConsecutiveSameFailures', () => {
  function journal(...sets: string[]): string {
    const file = path.join(tmpDir, 'diagnosis-journal.md')
    const blocks = sets.map((s, i) => `## Iteration ${i + 1} — 2026-04-28T10:1${i}:00Z\n\n- failingTests: ${s}\n`)
    fs.writeFileSync(file, blocks.join('\n'))
    return file
  }

  it('returns 0 when the current failing set is empty', () => {
    expect(countConsecutiveSameFailures(journal('a'), [])).toBe(0)
  })

  it('returns 1 when there is no journal (no prior cycles)', () => {
    expect(countConsecutiveSameFailures(path.join(tmpDir, 'missing.md'), ['a'])).toBe(1)
  })

  it('counts the current observation plus each trailing iteration with the same set', () => {
    // current = a,b; two trailing iterations failed on a,b → streak 3.
    expect(countConsecutiveSameFailures(journal('a, b', 'a, b'), ['a', 'b'])).toBe(3)
  })

  it('is order-insensitive on the failing-set signature', () => {
    expect(countConsecutiveSameFailures(journal('b, a'), ['a', 'b'])).toBe(2)
  })

  it('stops at the first differing trailing iteration', () => {
    // newest→oldest: a (match), then x (different) → streak = current(1) + 1 = 2.
    expect(countConsecutiveSameFailures(journal('x', 'a'), ['a'])).toBe(2)
  })

  it('stops (does not count) at a trailing iteration with no failingTests field', () => {
    // The newest iteration has an explicitly empty failingTests value (the
    // journal append happened before the summary was ready) — the walk
    // breaks immediately, same as a missing journal entirely.
    expect(countConsecutiveSameFailures(journal('x', ''), ['a'])).toBe(1)
  })
})

describe('stuckSlugsFromJournal', () => {
  function journal(...sets: string[]): string {
    const file = path.join(tmpDir, 'diagnosis-journal.md')
    const blocks = sets.map((s, i) => `## Iteration ${i + 1} — 2026-04-28T10:1${i}:00Z\n\n- failingTests: ${s}\n`)
    fs.writeFileSync(file, blocks.join('\n'))
    return file
  }

  it('returns empty when the current failing set is empty', () => {
    expect(stuckSlugsFromJournal(journal('a'), [], 3)).toEqual({ stuck: [], maxStreak: 0 })
  })

  it('every streak is 1 without a journal', () => {
    expect(stuckSlugsFromJournal(path.join(tmpDir, 'missing.md'), ['a'], 3))
      .toEqual({ stuck: [], maxStreak: 1 })
  })

  it('flags a test that kept failing while siblings churned the set', () => {
    // Iterations: {a,b,flaky} → {a,b} — the exact-set signature changed both
    // times, but a and b have now failed 3 observations in a row.
    const j = journal('a, b, flaky', 'a, b')
    expect(stuckSlugsFromJournal(j, ['a', 'b', 'newcomer'], 3))
      .toEqual({ stuck: ['a', 'b'], maxStreak: 3 })
  })

  it('a recovered-then-refailed test restarts its streak', () => {
    // b failed, recovered (absent), failed again → streak 2, not 4.
    const j = journal('b', 'a', 'a, b')
    expect(stuckSlugsFromJournal(j, ['b'], 3)).toEqual({ stuck: [], maxStreak: 2 })
  })

  it('treats an iteration with no failingTests field as an empty prior set', () => {
    // Iteration 1 never got a failingTests line at all (not even empty) —
    // `e.failingTests ?? ''` must fall back so the map/split/filter chain
    // still runs instead of throwing.
    const file = path.join(tmpDir, 'diagnosis-journal.md')
    fs.writeFileSync(file, `## Iteration 1 — t1\n\n- hypothesis: no failingTests here\n- signal: .restart\n- outcome: pending\n`)
    expect(stuckSlugsFromJournal(file, ['a'], 2)).toEqual({ stuck: [], maxStreak: 1 })
  })
})

describe('nextIterationNumber', () => {
  it('returns 1 for missing file', () => {
    expect(nextIterationNumber(path.join(tmpDir, 'missing.md'))).toBe(1)
  })

  it('returns max + 1', () => {
    const file = path.join(tmpDir, 'j.md')
    fs.writeFileSync(
      file,
      `## Iteration 3 — t\n\n- hypothesis: x\n- signal: .restart\n- outcome: pending\n`,
    )
    expect(nextIterationNumber(file)).toBe(4)
  })

  it('ignores an out-of-order lower iteration number after a higher one', () => {
    // Entries aren't guaranteed ascending on disk — the reduce must keep the
    // running max rather than trusting array order.
    const file = path.join(tmpDir, 'j.md')
    fs.writeFileSync(
      file,
      `## Iteration 5 — t1\n\n- hypothesis: first\n\n## Iteration 2 — t2\n\n- hypothesis: second\n`,
    )
    expect(nextIterationNumber(file)).toBe(6)
  })
})

describe('writeFullDiffPatch', () => {
  it('writes the full diff under <runDir>/diffs and returns a path', () => {
    const journalPath = path.join(tmpDir, 'diagnosis-journal.md')
    const rel = writeFullDiffPatch(journalPath, 3, 'diff --git a/x b/x\n+y')
    expect(rel).not.toBeNull()
    const file = path.join(tmpDir, 'diffs', 'iteration-3.patch')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf-8').endsWith('\n')).toBe(true)
  })

  it('does not append an extra newline when the diff already ends with one', () => {
    const journalPath = path.join(tmpDir, 'diagnosis-journal.md')
    const diff = 'diff --git a/x b/x\n+y\n'
    writeFullDiffPatch(journalPath, 7, diff)
    const file = path.join(tmpDir, 'diffs', 'iteration-7.patch')
    expect(fs.readFileSync(file, 'utf-8')).toBe(diff)
  })

  it('returns null when the diffs directory cannot be created', () => {
    const journalPath = path.join(tmpDir, 'diagnosis-journal.md')
    // Occupy the target directory path with a plain file so mkdirSync throws.
    fs.writeFileSync(path.join(tmpDir, 'diffs'), 'blocking file')
    expect(writeFullDiffPatch(journalPath, 1, 'diff content')).toBeNull()
  })
})

describe('truncateDiffForJournal', () => {
  it('returns the input unchanged when under the cap', () => {
    expect(truncateDiffForJournal('short')).toBe('short')
  })

  it('truncates oversized diffs and appends a byte-count marker', () => {
    const oneLine = 'a'.repeat(80) + '\n'
    const huge = oneLine.repeat(200) // 200 lines × 81 bytes = 16200 bytes
    const truncated = truncateDiffForJournal(huge)
    expect(Buffer.byteLength(truncated, 'utf-8')).toBeLessThan(MAX_JOURNAL_DIFF_BYTES + 80)
    expect(truncated).toMatch(/\.\.\. \(truncated, \d+ more bytes\)$/)
  })

  it('respects an explicit max argument', () => {
    const text = 'line1\nline2\nline3\nline4\n'
    const truncated = truncateDiffForJournal(text, 10)
    expect(truncated).toMatch(/\.\.\. \(truncated, \d+ more bytes\)$/)
    expect(truncated.length).toBeLessThan(text.length + 40)
  })

  it('keeps the head byte-for-byte when the truncation point falls before any newline', () => {
    // A single huge line has no '\n' within the head window at all, so
    // lastIndexOf('\n') is -1 and the head must be used unmodified rather
    // than sliced back to a (nonexistent) prior line boundary.
    const huge = 'x'.repeat(500)
    const truncated = truncateDiffForJournal(huge, 100)
    expect(truncated.startsWith('x'.repeat(100))).toBe(true)
    expect(truncated).toMatch(/\.\.\. \(truncated, \d+ more bytes\)$/)
  })
})

describe('classifyJournalOutcome', () => {
  it('marks a clean verification rerun as all_passed', () => {
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }] },
      { failed: [] },
    )).toBe('all_passed')
  })

  it('distinguishes partial, no_change, and regression outcomes', () => {
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }, { name: 'b' }], passedNames: [] },
      { failed: [{ name: 'b' }] },
    )).toBe('partial')
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }], passedNames: [] },
      { failed: [{ name: 'a' }] },
    )).toBe('no_change')
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }], passedNames: ['b'] },
      { failed: [{ name: 'a' }, { name: 'b' }] },
    )).toBe('regression')
  })

  it('calls it advanced, not regression, when the fix cleared the blocker and the suite reached a test that had never run', () => {
    // The shape of run 2026-08-07T0709-33ng, which ran with --max-failures=1:
    // j0 had passed, j1 was the blocker, j2..j6 had never executed. The fix
    // cleared j1 and the suite then stopped at j2 — a name absent from BOTH
    // the before-failures and the before-passes, so it was never green and
    // cannot have regressed. Classifying this as `regression` steered the next
    // cycle to revert a fix that had just worked.
    expect(classifyJournalOutcome(
      { failed: [{ name: 'j1' }], passedNames: ['j0'] },
      { failed: [{ name: 'j2' }] },
    )).toBe('advanced')
  })

  it('still reports regression when a fix clears one test and breaks a green one', () => {
    // Progress does not excuse damage: `regression` outranks `advanced` so the
    // revert-first steer survives a cycle that also fixed something.
    expect(classifyJournalOutcome(
      { failed: [{ name: 'j1' }], passedNames: ['j0'] },
      { failed: [{ name: 'j0' }] },
    )).toBe('regression')
  })

  it('reports partial, not advanced, when every remaining failure was already known', () => {
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }, { name: 'b' }], passedNames: ['c'] },
      { failed: [{ name: 'b' }] },
    )).toBe('partial')
  })

  it('reports no_change when nothing was cleared, even if the run surfaced a never-run failure', () => {
    // The blocker did not move, which is the fact the next cycle must act on.
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }], passedNames: ['c'] },
      { failed: [{ name: 'a' }, { name: 'never-ran' }] },
    )).toBe('no_change')
  })

  it('falls back to the legacy any-new-failure regression rule when the before summary predates passedNames', () => {
    // Without `passedNames` there is no way to tell a broken-green test from
    // one that had never run. Erring toward `regression` costs a revert cycle;
    // the other direction would hide a real regression.
    expect(classifyJournalOutcome(
      { failed: [{ name: 'j1' }] },
      { failed: [{ name: 'j2' }] },
    )).toBe('regression')
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }, { name: 'b' }] },
      { failed: [{ name: 'b' }] },
    )).toBe('partial')
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }] },
      { failed: [{ name: 'a' }] },
    )).toBe('no_change')
  })

  it('ignores a non-array or non-string-laden passedNames rather than trusting it', () => {
    // A malformed summary must not silently disable the regression check: a
    // `passedNames` that is not an array reads as "field absent" (legacy rule),
    // and non-string entries inside a real array are dropped.
    expect(classifyJournalOutcome(
      { failed: [{ name: 'j1' }], passedNames: 'j0' },
      { failed: [{ name: 'j2' }] },
    )).toBe('regression')
    expect(classifyJournalOutcome(
      { failed: [{ name: 'j1' }], passedNames: [null, 42, 'j0'] },
      { failed: [{ name: 'j2' }] },
    )).toBe('advanced')
  })

  it('treats a summary object with no `failed` field as zero failures', () => {
    expect(classifyJournalOutcome({}, {})).toBe('all_passed')
  })
})

describe('updateLatestPendingJournalOutcome', () => {
  it('updates the newest pending section for the selected run', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    fs.writeFileSync(journalPath, `# Diagnosis Journal

## Iteration 1 — t1

- run: run-a
- hypothesis: old
- outcome: pending

## Iteration 2 — t2

- run: run-b
- hypothesis: other
- outcome: pending

## Iteration 3 — t3

- run: run-a
- hypothesis: latest
- outcome: pending
`)

    expect(updateLatestPendingJournalOutcome({
      journalPath,
      runId: 'run-a',
      outcome: 'all_passed',
    })).toBe(true)

    const body = fs.readFileSync(journalPath, 'utf-8')
    expect(body).toContain('## Iteration 1 — t1\n\n- run: run-a\n- hypothesis: old\n- outcome: pending')
    expect(body).toContain('## Iteration 2 — t2\n\n- run: run-b\n- hypothesis: other\n- outcome: pending')
    expect(body).toContain('## Iteration 3 — t3\n\n- run: run-a\n- hypothesis: latest\n- outcome: all_passed')
  })

  it('returns false when no pending section matches', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    fs.writeFileSync(journalPath, `## Iteration 1 — t1

- run: run-a
- outcome: no_change
`)

    expect(updateLatestPendingJournalOutcome({
      journalPath,
      runId: 'run-a',
      outcome: 'all_passed',
    })).toBe(false)
  })

  it('skips a newer non-matching section and updates the next matching one', () => {
    // The newest section belongs to a different run — the scan must `continue`
    // past it instead of stopping, then find and update the older match.
    const journalPath = path.join(tmpDir, 'j.md')
    fs.writeFileSync(journalPath, `## Iteration 1 — t1

- run: run-a
- outcome: pending

## Iteration 2 — t2

- run: run-b
- outcome: pending
`)

    expect(updateLatestPendingJournalOutcome({
      journalPath,
      runId: 'run-a',
      outcome: 'all_passed',
    })).toBe(true)

    const body = fs.readFileSync(journalPath, 'utf-8')
    expect(body).toContain('- run: run-a\n- outcome: all_passed')
    // The skipped (non-matching, newer) section is untouched.
    expect(body).toContain('- run: run-b\n- outcome: pending')
  })
})
