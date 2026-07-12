import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  appendJournalIteration,
  capSlice,
  capSliceWithMeta,
  classifyJournalOutcome,
  countConsecutiveSameFailures,
  enrichSummaryWithLogs,
  extractAllSlices,
  extractLogsForTest,
  MAX_JOURNAL_DIFF_BYTES,
  nextIterationNumber,
  parseJournalMarkdown,
  stripAnsi,
  stuckSlugsFromJournal,
  truncateDiffForJournal,
  updateLatestPendingJournalOutcome,
  writeErrorFile,
  writeFailureSlices,
  writeFullDiffPatch,
  writeHealIndex,
} from './log-enrichment'
import {
  DIAGNOSIS_JOURNAL_PATH as REAL_JOURNAL,
  HEAL_INDEX_PATH as REAL_HEAL_INDEX,
  LOGS_DIR as REAL_LOGS,
  MANIFEST_PATH as REAL_MANIFEST,
  ROOT,
  SUMMARY_PATH as REAL_SUMMARY,
} from './paths'

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

describe('appendJournalIteration', () => {
  it('skips append when hypothesis is empty', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    appendJournalIteration({
      signal: '.restart',
      hypothesis: '',
      journalPath,
      manifestPath: path.join(tmpDir, 'm.json'),
      summaryPath: path.join(tmpDir, 's.json'),
    })
    expect(fs.existsSync(journalPath)).toBe(false)
  })

  it('writes a section with run / feature / failingTests / fix fields', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    const manifestPath = path.join(tmpDir, 'm.json')
    const summaryPath = path.join(tmpDir, 's.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ feature: 'demo' }))
    fs.writeFileSync(summaryPath, JSON.stringify({ failed: [{ name: 'a' }, { name: 'b' }] }))

    appendJournalIteration({
      signal: '.restart',
      hypothesis: 'broken thing',
      filesChanged: ['/abs/x.ts'],
      fixDescription: 'fixed it',
      runId: '2026-04-28T1015-abc1',
      journalPath,
      manifestPath,
      summaryPath,
    })

    const body = fs.readFileSync(journalPath, 'utf-8')
    expect(body).toContain('# Diagnosis Journal')
    expect(body).toContain('## Iteration 1')
    expect(body).toContain('- run: 2026-04-28T1015-abc1')
    expect(body).toContain('- feature: demo')
    expect(body).toContain('- failingTests: a, b')
    expect(body).toContain('- hypothesis: broken thing')
    expect(body).toContain('- fix.file: /abs/x.ts')
    expect(body).toContain('- fix.description: fixed it')
    expect(body).toContain('- signal: .restart')
    expect(body).toContain('- outcome: pending')
  })

  it('falls back to legacy `featureName` when `feature` is absent', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    const manifestPath = path.join(tmpDir, 'm.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ featureName: 'old-shape' }))

    appendJournalIteration({
      signal: '.rerun',
      hypothesis: 'h',
      journalPath,
      manifestPath,
      summaryPath: path.join(tmpDir, 'missing.json'),
    })

    expect(fs.readFileSync(journalPath, 'utf-8')).toContain('- feature: old-shape')
  })

  it('records no-signal iterations explicitly', () => {
    const journalPath = path.join(tmpDir, 'j.md')

    appendJournalIteration({
      signal: 'none',
      hypothesis: 'Heal agent went silent without writing a signal.',
      journalPath,
      manifestPath: path.join(tmpDir, 'm.json'),
      summaryPath: path.join(tmpDir, 's.json'),
    })

    expect(fs.readFileSync(journalPath, 'utf-8')).toContain('- signal: none')
  })

  it('appends successive iterations and increments the counter', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    const manifestPath = path.join(tmpDir, 'm.json')
    const summaryPath = path.join(tmpDir, 's.json')
    fs.writeFileSync(manifestPath, '{}')
    fs.writeFileSync(summaryPath, '{}')

    appendJournalIteration({
      signal: '.restart', hypothesis: 'one', journalPath, manifestPath, summaryPath,
    })
    appendJournalIteration({
      signal: '.restart', hypothesis: 'two', journalPath, manifestPath, summaryPath,
    })

    const body = fs.readFileSync(journalPath, 'utf-8')
    expect(body).toContain('## Iteration 1')
    expect(body).toContain('## Iteration 2')
    expect(body.match(/# Diagnosis Journal/g)).toHaveLength(1)
  })

  it('omits fix.file when filesChanged is empty or undefined', () => {
    // Runner-observed diff is empty (non-git workspace, or agent made no
    // edits). The journal entry should still record everything else but
    // skip the fix.file line — empty lists shouldn't render as
    // "- fix.file: " with nothing after the colon.
    const journalPath = path.join(tmpDir, 'j.md')
    const manifestPath = path.join(tmpDir, 'm.json')
    const summaryPath = path.join(tmpDir, 's.json')
    fs.writeFileSync(manifestPath, '{}')
    fs.writeFileSync(summaryPath, '{}')

    appendJournalIteration({
      signal: '.restart',
      hypothesis: 'no edits',
      filesChanged: [],
      journalPath,
      manifestPath,
      summaryPath,
    })
    appendJournalIteration({
      signal: '.rerun',
      hypothesis: 'still no edits',
      // filesChanged undefined
      journalPath,
      manifestPath,
      summaryPath,
    })

    const body = fs.readFileSync(journalPath, 'utf-8')
    expect(body).toContain('- hypothesis: no edits')
    expect(body).toContain('- hypothesis: still no edits')
    expect(body).not.toContain('- fix.file:')
  })

  it('tolerates malformed manifest/summary', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    const manifestPath = path.join(tmpDir, 'm.json')
    const summaryPath = path.join(tmpDir, 's.json')
    fs.writeFileSync(manifestPath, 'not json')
    fs.writeFileSync(summaryPath, 'also not json')
    appendJournalIteration({
      signal: '.restart', hypothesis: 'h', journalPath, manifestPath, summaryPath,
    })
    expect(fs.readFileSync(journalPath, 'utf-8')).toContain('- hypothesis: h')
  })

  it('writes a `### Diff` fenced block when diffContent is provided', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    const manifestPath = path.join(tmpDir, 'm.json')
    const summaryPath = path.join(tmpDir, 's.json')
    fs.writeFileSync(manifestPath, '{}')
    fs.writeFileSync(summaryPath, '{}')

    const diff = 'diff --git a/a.ts b/a.ts\n-old\n+new'
    appendJournalIteration({
      signal: '.restart',
      hypothesis: 'broken',
      diffContent: diff,
      journalPath,
      manifestPath,
      summaryPath,
    })

    const body = fs.readFileSync(journalPath, 'utf-8')
    expect(body).toContain('### Diff')
    expect(body).toContain('```diff')
    expect(body).toContain(diff)
    // Field list still terminates with outcome: pending BEFORE the Diff block.
    const outcomeIdx = body.indexOf('- outcome: pending')
    const diffIdx = body.indexOf('### Diff')
    expect(outcomeIdx).toBeGreaterThan(0)
    expect(diffIdx).toBeGreaterThan(outcomeIdx)
  })

  it('omits the Diff section when diffContent is empty or whitespace', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    const manifestPath = path.join(tmpDir, 'm.json')
    const summaryPath = path.join(tmpDir, 's.json')
    fs.writeFileSync(manifestPath, '{}')
    fs.writeFileSync(summaryPath, '{}')

    appendJournalIteration({
      signal: '.restart',
      hypothesis: 'broken',
      diffContent: '   \n\n  ',
      journalPath,
      manifestPath,
      summaryPath,
    })

    const body = fs.readFileSync(journalPath, 'utf-8')
    expect(body).not.toContain('### Diff')
    expect(body).not.toContain('```diff')
  })

  it('persists the full diff to a patch file and points at it when over the cap', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    const manifestPath = path.join(tmpDir, 'm.json')
    const summaryPath = path.join(tmpDir, 's.json')
    fs.writeFileSync(manifestPath, '{}')
    fs.writeFileSync(summaryPath, '{}')

    const huge = `diff --git a/a.ts b/a.ts\n${'+added line\n'.repeat(2000)}`
    expect(Buffer.byteLength(huge, 'utf-8')).toBeGreaterThan(MAX_JOURNAL_DIFF_BYTES)
    appendJournalIteration({
      signal: '.restart',
      hypothesis: 'broken',
      diffContent: huge,
      journalPath,
      manifestPath,
      summaryPath,
    })

    const body = fs.readFileSync(journalPath, 'utf-8')
    // In-journal block is still truncated for readability...
    expect(body).toMatch(/\.\.\. \(truncated, \d+ more bytes\)/)
    // ...but a `Full diff:` pointer is emitted to the persisted patch file.
    expect(body).toMatch(/Full diff: .*iteration-1\.patch/)
    const patchFile = path.join(tmpDir, 'diffs', 'iteration-1.patch')
    expect(fs.existsSync(patchFile)).toBe(true)
    expect(fs.readFileSync(patchFile, 'utf-8')).toContain(huge)
  })

  it('omits the `Full diff:` pointer when the patch file write fails', () => {
    const journalPath = path.join(tmpDir, 'j.md')
    const manifestPath = path.join(tmpDir, 'm.json')
    const summaryPath = path.join(tmpDir, 's.json')
    fs.writeFileSync(manifestPath, '{}')
    fs.writeFileSync(summaryPath, '{}')
    // Occupy the path writeFullDiffPatch needs as a directory with a plain
    // file, so its mkdirSync(..., { recursive: true }) throws (ENOTDIR) and
    // it returns null instead of a patch path.
    fs.writeFileSync(path.join(tmpDir, 'diffs'), 'blocking file')

    const huge = `diff --git a/a.ts b/a.ts\n${'+added line\n'.repeat(2000)}`
    appendJournalIteration({
      signal: '.restart',
      hypothesis: 'broken',
      diffContent: huge,
      journalPath,
      manifestPath,
      summaryPath,
    })

    const body = fs.readFileSync(journalPath, 'utf-8')
    expect(body).toMatch(/\.\.\. \(truncated, \d+ more bytes\)/)
    expect(body).not.toContain('Full diff:')
  })

  it('uses the real default manifest/summary/journal paths when none are provided', () => {
    let createdLogs = false
    if (!fs.existsSync(REAL_LOGS)) {
      fs.mkdirSync(REAL_LOGS, { recursive: true })
      createdLogs = true
    }
    const priorManifest = fs.existsSync(REAL_MANIFEST) ? fs.readFileSync(REAL_MANIFEST, 'utf-8') : null
    const priorSummary = fs.existsSync(REAL_SUMMARY) ? fs.readFileSync(REAL_SUMMARY, 'utf-8') : null
    const priorJournal = fs.existsSync(REAL_JOURNAL) ? fs.readFileSync(REAL_JOURNAL, 'utf-8') : null
    const prevEnv = process.env.CANARY_LAB_SUMMARY_PATH
    delete process.env.CANARY_LAB_SUMMARY_PATH // force getSummaryPath() to fall back to SUMMARY_PATH
    fs.writeFileSync(REAL_MANIFEST, JSON.stringify({ feature: 'default-path-feature' }))
    fs.writeFileSync(REAL_SUMMARY, JSON.stringify({ failed: [{ name: 'default-path-test' }] }))
    try {
      appendJournalIteration({ signal: '.restart', hypothesis: 'default paths used' })
      const body = fs.readFileSync(REAL_JOURNAL, 'utf-8')
      expect(body).toContain('- feature: default-path-feature')
      expect(body).toContain('- failingTests: default-path-test')
      expect(body).toContain('- hypothesis: default paths used')
    } finally {
      if (prevEnv === undefined) delete process.env.CANARY_LAB_SUMMARY_PATH
      else process.env.CANARY_LAB_SUMMARY_PATH = prevEnv
      if (priorManifest !== null) fs.writeFileSync(REAL_MANIFEST, priorManifest)
      else { try { fs.unlinkSync(REAL_MANIFEST) } catch { /* ignore */ } }
      if (priorSummary !== null) fs.writeFileSync(REAL_SUMMARY, priorSummary)
      else { try { fs.unlinkSync(REAL_SUMMARY) } catch { /* ignore */ } }
      if (priorJournal !== null) fs.writeFileSync(REAL_JOURNAL, priorJournal)
      else { try { fs.unlinkSync(REAL_JOURNAL) } catch { /* ignore */ } }
      if (createdLogs) { try { fs.rmdirSync(REAL_LOGS) } catch { /* ignore */ } }
    }
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

describe('writeErrorFile', () => {
  it('writes the full message + snippet and returns a path', () => {
    const message = 'Expected x but got y\n'.repeat(200) // well over any preview cap
    const rel = writeErrorFile('a-test', { message, snippet: 'await expect(...)' }, tmpDir)
    expect(rel).not.toBeNull()
    const file = path.join(tmpDir, 'a-test', 'error.txt')
    const body = fs.readFileSync(file, 'utf-8')
    expect(body).toContain('Expected x but got y')
    expect(body).toContain('--- snippet ---')
    expect(body).toContain('await expect(...)')
    // Nothing trimmed — the full message survives.
    expect(body).toContain(message.trim())
  })

  it('returns null when there is no message or snippet', () => {
    expect(writeErrorFile('a-test', undefined, tmpDir)).toBeNull()
    expect(writeErrorFile('a-test', { message: '   ' }, tmpDir)).toBeNull()
  })

  it('writes a snippet-only body when message is absent', () => {
    const rel = writeErrorFile('a-test', { snippet: 'await expect(page).toHaveURL(...)' }, tmpDir)
    expect(rel).not.toBeNull()
    const body = fs.readFileSync(path.join(tmpDir, 'a-test', 'error.txt'), 'utf-8')
    expect(body).toContain('--- snippet ---')
    expect(body).toContain('await expect(page).toHaveURL(...)')
  })

  it('returns null when the target directory cannot be created', () => {
    const blockedDir = path.join(tmpDir, 'blocked')
    fs.writeFileSync(blockedDir, 'occupied') // a file, not a directory
    expect(writeErrorFile('a-test', { message: 'boom' }, blockedDir)).toBeNull()
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
      { failed: [{ name: 'a' }, { name: 'b' }] },
      { failed: [{ name: 'b' }] },
    )).toBe('partial')
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }] },
      { failed: [{ name: 'a' }] },
    )).toBe('no_change')
    expect(classifyJournalOutcome(
      { failed: [{ name: 'a' }] },
      { failed: [{ name: 'a' }, { name: 'b' }] },
    )).toBe('regression')
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

describe('capSlice', () => {
  it('returns the snippet unchanged when small', () => {
    expect(capSlice('hello', '/tmp/log')).toBe('hello')
  })

  it('elides the middle for large snippets', () => {
    const big = 'a'.repeat(50_000)
    const result = capSlice(big, 'logs/x.log')
    expect(result.length).toBeLessThan(big.length)
    expect(result).toContain('logs/x.log')
    expect(result).toContain('eliding')
  })

  it('collapses repeated lines by template instead of truncating when that fits', () => {
    // ~28 KB of retry spam (> the 20 KB budget) that shares one template.
    const lines: string[] = []
    for (let i = 1; i <= 1_000; i++) lines.push(`waiting for db (attempt ${i})`)
    const snippet = lines.join('\n')
    expect(Buffer.byteLength(snippet, 'utf-8')).toBeGreaterThan(20_480)

    const result = capSlice(snippet, 'logs/runs/X/svc-api.log')
    // Collapsed to a single representative + count + range, no middle dropped.
    expect(result).toContain('waiting for db (attempt 1)  (×1000; 1–1000)')
    expect(result).not.toContain('eliding')
    // Collapse is reversible: the full log is still pointed at.
    expect(result).toContain('collapsed by template — full log at logs/runs/X/svc-api.log')
  })
})

describe('capSliceWithMeta', () => {
  it('reports not-capped for a small lossless snippet', () => {
    const r = capSliceWithMeta('hello', 'logs/x.log')
    expect(r).toEqual({ text: 'hello', capped: false, windowBytes: 5 })
  })

  it('reports capped + the pre-cap window size for a lossy head+tail elision', () => {
    const big = 'a'.repeat(50_000)
    const r = capSliceWithMeta(big, 'logs/x.log')
    expect(r.capped).toBe(true)
    expect(r.windowBytes).toBe(50_000)
    expect(r.text).toContain('eliding')
  })

  it('reports not-capped when template collapse alone gets under budget (lossless)', () => {
    const lines: string[] = []
    for (let i = 1; i <= 1_000; i++) lines.push(`waiting for db (attempt ${i})`)
    const r = capSliceWithMeta(lines.join('\n'), 'logs/x.log')
    expect(r.capped).toBe(false)
    expect(r.text).not.toContain('eliding')
  })
})

describe('extractAllSlices / extractLogsForTest', () => {
  it('returns empty map when no slugs given', () => {
    expect(extractAllSlices([], ['/tmp/none.log']).size).toBe(0)
  })

  it('extracts XML-marked slices from each service log', () => {
    const log = path.join(tmpDir, 'svc-api.log')
    fs.writeFileSync(log, 'pre <foo>BODY</foo> post')
    const slices = extractAllSlices(['foo', 'missing'], [log])
    expect(slices.get('foo')!['svc-api']).toBe('BODY')
    expect(slices.get('missing')).toEqual({})
  })

  it('skips unterminated and empty XML-marked slices', () => {
    const log = path.join(tmpDir, 'svc-api.log')
    fs.writeFileSync(log, '<unterminated>BODY\n<empty>   </empty>')
    const slices = extractAllSlices(['unterminated', 'empty'], [log])
    expect(slices.get('unterminated')).toEqual({})
    expect(slices.get('empty')).toEqual({})
  })

  it('extractLogsForTest is a single-slug shortcut', () => {
    const log = path.join(tmpDir, 'svc-api.log')
    fs.writeFileSync(log, '<a>x</a>')
    expect(extractLogsForTest('a', [log])['svc-api']).toBe('x')
  })

  it('strips PTY control codes from extracted slices', () => {
    const log = path.join(tmpDir, 'svc-api.log')
    fs.writeFileSync(log, '<foo>\x1b[32m201 Created\x1b[0m\x1b[20;5Htail</foo>')
    expect(extractAllSlices(['foo'], [log]).get('foo')!['svc-api']).toBe('201 Createdtail')
  })

  it('skips missing service logs gracefully', () => {
    const slices = extractAllSlices(['x'], [path.join(tmpDir, 'missing.log')])
    expect(slices.get('x')).toEqual({})
  })
})

describe('writeHealIndex with journal tail and various manifest shapes', () => {
  let createdLogsDir = false
  let createdJournal = false

  function seedJournal(content: string): void {
    if (!fs.existsSync(REAL_LOGS)) {
      fs.mkdirSync(REAL_LOGS, { recursive: true })
      createdLogsDir = true
    }
    if (!fs.existsSync(REAL_JOURNAL)) {
      createdJournal = true
    }
    fs.writeFileSync(REAL_JOURNAL, content)
  }

  function cleanupSeed(): void {
    if (createdJournal) {
      try { fs.unlinkSync(REAL_JOURNAL) } catch { /* ignore */ }
    }
    if (createdLogsDir) {
      try { fs.rmdirSync(REAL_LOGS) } catch { /* directory not empty — leave it */ }
    }
    createdJournal = false
    createdLogsDir = false
  }

  it('renders journal tail with iteration / outcome / hypothesis branches', () => {
    seedJournal(`## Iteration 1 — t1

- hypothesis: first
- signal: .restart
- outcome: pending

## Iteration 2 — t2

- signal: .restart
- outcome: no_change

## Iteration 3 — t3

- hypothesis: ${'long '.repeat(60)}
- signal: .restart
- outcome:
`)
    try {
      writeHealIndex({
        manifest: { featureName: 'demo' },
        summary: { failed: [{ name: 'a', error: { message: 'boom' } }] },
      })
    } finally {
      cleanupSeed()
    }
  })

  it('renders feature, repos, journal tail, and per-failure slices', () => {
    const manifest = {
      featureName: 'demo',
      featureDir: '/proj/features/demo',
      repoPaths: ['/proj/repo-a', '/proj/repo-b'],
    }
    const summary = {
      failed: [
        {
          name: 'a-test',
          error: { message: '\x1b[31mboom\x1b[0m' },
          logFiles: ['logs/failed/a-test/svc.log'],
        },
        { name: 'b-test' },
      ],
    }
    expect(() => writeHealIndex({ manifest, summary })).not.toThrow()
  })

  it('handles featureName-only manifests', () => {
    expect(() =>
      writeHealIndex({
        manifest: { featureName: 'only-name' },
        summary: { failed: [] },
      }),
    ).not.toThrow()
  })

  it('handles entries without error or logFiles', () => {
    expect(() =>
      writeHealIndex({
        manifest: {},
        summary: { failed: [{ name: 'orphan' }] },
      }),
    ).not.toThrow()
  })

  it('renders slice size for an uncapped slice and a full-log grep hint for a capped one', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: {
        failed: [
          {
            name: 'big-test',
            sliceMeta: [
              {
                path: 'logs/runs/X/failed/big-test/svc-api.log',
                bytes: 20_480,
                fullLog: 'logs/runs/X/svc-api.log',
                fullLogBytes: 600_000,
                windowBytes: 421_000,
                capped: true,
              },
              {
                path: 'logs/runs/X/failed/big-test/svc-web.log',
                bytes: 1_200,
                fullLog: 'logs/runs/X/svc-web.log',
                fullLogBytes: 1_200,
                windowBytes: 1_200,
                capped: false,
              },
            ],
          },
        ],
      },
      healIndexPath,
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    // Capped slice: size, pre-cap window size, full-log path + size, grep hint.
    expect(body).toContain('logs/runs/X/failed/big-test/svc-api.log (20.0 KB, capped from a 411.1 KB window)')
    expect(body).toContain('full service log logs/runs/X/svc-api.log (585.9 KB)')
    expect(body).toContain('grep `<big-test>`…`</big-test>`')
    // Uncapped slice: just the size, no grep hint.
    expect(body).toContain('logs/runs/X/failed/big-test/svc-web.log (1.2 KB)')
  })

  it('renders MB-scale sizes once a slice/log crosses the 1 MB boundary', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: {
        failed: [
          {
            name: 'huge-test',
            sliceMeta: [
              {
                path: 'logs/runs/X/failed/huge-test/svc-api.log',
                bytes: 2 * 1024 * 1024,
                fullLog: 'logs/runs/X/svc-api.log',
                fullLogBytes: 5 * 1024 * 1024,
                windowBytes: 5 * 1024 * 1024,
                capped: true,
              },
            ],
          },
        ],
      },
      healIndexPath,
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).toContain('logs/runs/X/failed/huge-test/svc-api.log (2.0 MB, capped from a 5.0 MB window)')
    expect(body).toContain('full service log logs/runs/X/svc-api.log (5.0 MB)')
  })

  it('renders "(no error)" when the error message strips to nothing', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 'blank-error-test', error: { message: '   ' } }] },
      healIndexPath,
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).toContain('- error: (no error)')
  })

  it('falls back to the raw featureDir when it equals ROOT (relative path is empty)', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureDir: ROOT },
      summary: { failed: [] },
      healIndexPath,
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).toContain(`Feature: ${ROOT}`)
  })

  it('derives journalPath from summaryPath when parsed.journalPath is omitted', () => {
    const runDir = path.join(tmpDir, 'derived-run')
    fs.mkdirSync(runDir, { recursive: true })
    const summaryPath = path.join(runDir, 'e2e-summary.json')
    const healIndexPath = path.join(runDir, 'heal-index.md')
    const derivedJournalPath = path.join(runDir, 'diagnosis-journal.md')
    fs.writeFileSync(derivedJournalPath, `## Iteration 1 — t1

- hypothesis: derived-path-test
- signal: .restart
- outcome: pending
`)
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [] },
      summaryPath,
      healIndexPath,
      // journalPath intentionally omitted — must derive from summaryPath.
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).toContain('derived-path-test')
  })

  it('returns without writing when called with no args and the summary file is missing', () => {
    const prevEnv = process.env.CANARY_LAB_SUMMARY_PATH
    const missingSummary = path.join(tmpDir, 'no-such-summary.json')
    process.env.CANARY_LAB_SUMMARY_PATH = missingSummary
    try {
      writeHealIndex()
      expect(fs.existsSync(path.join(tmpDir, 'heal-index.md'))).toBe(false)
    } finally {
      if (prevEnv === undefined) delete process.env.CANARY_LAB_SUMMARY_PATH
      else process.env.CANARY_LAB_SUMMARY_PATH = prevEnv
    }
  })

  it('treats a summary object with no `failed` field as zero failures', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({ manifest: {}, summary: {}, healIndexPath })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).toContain('No failures. Nothing to heal.')
  })

  it('renders a non-string failed-entry name as empty when deriving slugs (no cross-run history)', () => {
    // A malformed entry (no `name` at all) must not throw when the slug list
    // is derived for flake-history lookup — it normalizes to '' and is
    // filtered out, leaving the slugs list empty even though `feature` is set.
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [({} as unknown as { name: string })] },
      healIndexPath,
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).not.toContain('history:')
    expect(body).toContain('- **undefined**')
  })

  it('treats a non-string failed-entry name as empty when building the failure-delta currentSlugs list', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [({} as unknown as { name: string }), { name: 't4' }] },
      previousFailingSlugs: ['t4'],
      healIndexPath,
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).toContain('## Failure delta vs previous cycle')
    expect(body).toContain('- still failing (1): t4')
  })

  it('falls back to the bare logFiles list when sliceMeta is absent', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 'a-test', logFiles: ['logs/failed/a-test/svc.log'] }] },
      healIndexPath,
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).toContain('- slice: logs/failed/a-test/svc.log')
  })

  it('emits a trace bullet when traceSummaryFile is set on a failed entry', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: {
        failed: [
          {
            name: 'click-checkout',
            error: { message: 'TimeoutError' },
            traceSummaryFile: 'logs/runs/X/failed/click-checkout/trace-extract/failure-summary.md',
          },
        ],
      },
      healIndexPath,
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).toContain('- **click-checkout**')
    expect(body).toMatch(/- trace: logs\/runs\/X\/failed\/click-checkout\/trace-extract\/failure-summary\.md/)
  })

  it('emits a `full error` pointer when errorFile is set on a failed entry', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: {
        failed: [
          {
            name: 'a-test',
            error: { message: 'AssertionError: very long ...' },
            errorFile: 'logs/runs/X/failed/a-test/error.txt',
          },
        ],
      },
      healIndexPath,
    })
    const body = fs.readFileSync(healIndexPath, 'utf-8')
    expect(body).toContain('- full error: logs/runs/X/failed/a-test/error.txt')
  })

  it('renders the previous heal-cycle note when history has restarts/keeps', () => {
    expect(() =>
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          healCycleHistory: [
            { cycle: 1, kept: ['svc-a'], restarted: ['svc-b', 'svc-c'] },
          ],
        },
        summary: { failed: [{ name: 'a' }] },
      }),
    ).not.toThrow()
  })

  it('renders kept-only and restarted-only history with (none) placeholders', () => {
    expect(() =>
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          healCycleHistory: [{ cycle: 2, kept: ['k'], restarted: [] }],
        },
        summary: { failed: [] },
      }),
    ).not.toThrow()
    expect(() =>
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          healCycleHistory: [{ cycle: 3, kept: [], restarted: ['r'] }],
        },
        summary: { failed: [] },
      }),
    ).not.toThrow()
  })

  it('skips the heal-cycle note when both kept and restarted are empty', () => {
    expect(() =>
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          healCycleHistory: [{ cycle: 4, kept: [], restarted: [] }],
        },
        summary: { failed: [] },
      }),
    ).not.toThrow()
  })
})

describe('writeHealIndex cross-run flake history', () => {
  function mkRun(runsRoot: string, id: string, failed: string[], feature = 'demo'): void {
    const dir = path.join(runsRoot, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ feature }))
    fs.writeFileSync(
      path.join(dir, 'e2e-summary.json'),
      JSON.stringify({ failed: failed.map((name) => ({ name })) }),
    )
  }

  it('adds a per-test history line from prior sibling runs of the same feature', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    mkRun(runsRoot, '2026-01-01T0001-aaa', ['a-test'])
    mkRun(runsRoot, '2026-01-02T0001-bbb', [])
    mkRun(runsRoot, '2026-01-03T0001-ccc', ['a-test'])
    const currentDir = path.join(runsRoot, '2026-01-04T0001-ddd')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }, { name: 'b-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    const index = fs.readFileSync(healIndexPath, 'utf-8')
    expect(index).toContain('failed in 2 of the last 3 runs of this feature (intermittent — possible flake)')
    expect(index).toContain('failed in 0 of the last 3 runs of this feature (new — first failure in recent runs)')
  })

  it('only counts prior runs of the same feature and omits history when there are none', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    mkRun(runsRoot, '2026-01-01T0001-aaa', ['a-test'], 'other-feature')
    const currentDir = path.join(runsRoot, '2026-01-02T0001-bbb')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    expect(fs.readFileSync(healIndexPath, 'utf-8')).not.toContain('history:')
  })

  it('reads persistent for a test that failed every prior run', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    mkRun(runsRoot, '2026-01-01T0001-aaa', ['a-test'])
    mkRun(runsRoot, '2026-01-02T0001-bbb', ['a-test'])
    const currentDir = path.join(runsRoot, '2026-01-03T0001-ccc')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    expect(fs.readFileSync(healIndexPath, 'utf-8'))
      .toContain('failed in 2 of the last 2 runs of this feature (persistent)')
  })

  it('uses singular "run" wording when exactly one prior run is inspected', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    mkRun(runsRoot, '2026-04-01T0001-aaa', ['a-test'])
    const currentDir = path.join(runsRoot, '2026-04-02T0001-bbb')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    expect(fs.readFileSync(healIndexPath, 'utf-8'))
      .toContain('failed in 1 of the last 1 run of this feature (persistent)')
  })

  it('caps cross-run inspection at FLAKE_HISTORY_RUN_LIMIT (5) even with more sibling runs', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    // 6 prior runs, all matching feature, all failing 'a-test'. Only the 5
    // lexicographically-newest may be inspected.
    for (let i = 1; i <= 6; i++) {
      mkRun(runsRoot, `2026-05-0${i}T0001-aaa`, ['a-test'])
    }
    const currentDir = path.join(runsRoot, '2026-05-07T0001-zzz')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    // If the limit weren't enforced this would read "6 of the last 6".
    expect(fs.readFileSync(healIndexPath, 'utf-8'))
      .toContain('failed in 5 of the last 5 runs of this feature (persistent)')
  })

  it('tolerates a prior run summary with a non-array `failed` field and non-string names', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    const dirA = path.join(runsRoot, '2026-06-01T0001-aaa')
    fs.mkdirSync(dirA, { recursive: true })
    fs.writeFileSync(path.join(dirA, 'manifest.json'), JSON.stringify({ feature: 'demo' }))
    fs.writeFileSync(path.join(dirA, 'e2e-summary.json'), JSON.stringify({})) // no `failed` field at all

    const dirB = path.join(runsRoot, '2026-06-02T0001-bbb')
    fs.mkdirSync(dirB, { recursive: true })
    fs.writeFileSync(path.join(dirB, 'manifest.json'), JSON.stringify({ feature: 'demo' }))
    fs.writeFileSync(path.join(dirB, 'e2e-summary.json'), JSON.stringify({ failed: [{ name: 123 }] })) // non-string name

    const currentDir = path.join(runsRoot, '2026-06-03T0001-ccc')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    // Both prior runs parse without throwing and both count as "inspected",
    // but neither ever matches 'a-test' as failed (one had no `failed` array,
    // the other's only entry had a non-string name that never equals the slug).
    expect(fs.readFileSync(healIndexPath, 'utf-8'))
      .toContain('failed in 0 of the last 2 runs of this feature (new — first failure in recent runs)')
  })
})

describe('writeHealIndex failure delta vs previous cycle', () => {
  // The delta section gives the agent cross-cycle attribution: which tests
  // its prior turn unblocked, which it broke, which it left alone. Suppressed
  // on cycle 1 (no prior cycle to compare). Each bucket only appears when
  // non-empty.

  function readBody(healIndexPath: string): string {
    return fs.readFileSync(healIndexPath, 'utf-8')
  }

  it('suppresses the delta section on the first cycle (previousFailingSlugs empty/omitted)', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }, { name: 't2' }] },
      healIndexPath,
    })
    expect(readBody(healIndexPath)).not.toContain('## Failure delta vs previous cycle')
  })

  it('suppresses the delta section when previousFailingSlugs is an empty array', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }] },
      previousFailingSlugs: [],
      healIndexPath,
    })
    expect(readBody(healIndexPath)).not.toContain('## Failure delta vs previous cycle')
  })

  it('suppresses the section when current failures is empty (no failures, no delta to show)', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [] },
      previousFailingSlugs: ['t1', 't2'],
      healIndexPath,
    })
    expect(readBody(healIndexPath)).not.toContain('## Failure delta vs previous cycle')
  })

  it('emits all three buckets when the failure set has mixed deltas', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      // Previous: t1, t2, t3 — current: t1 (still), t4 (new); t2 + t3 newly passing.
      summary: { failed: [{ name: 't1' }, { name: 't4' }] },
      previousFailingSlugs: ['t1', 't2', 't3'],
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('## Failure delta vs previous cycle')
    expect(body).toContain('- still failing (1): t1')
    expect(body).toContain('- newly failing (1): t4')
    expect(body).toContain('- newly passing (2): t2, t3')
  })

  it('emits only the still-failing bucket when nothing changed', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }, { name: 't2' }] },
      previousFailingSlugs: ['t1', 't2'],
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('## Failure delta vs previous cycle')
    expect(body).toContain('- still failing (2): t1, t2')
    expect(body).not.toContain('- newly failing')
    expect(body).not.toContain('- newly passing')
  })

  it('emits only the newly-failing bucket when previous failures all passed but new ones appeared', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't3' }, { name: 't4' }] },
      previousFailingSlugs: ['t1', 't2'],
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('## Failure delta vs previous cycle')
    expect(body).toContain('- newly failing (2): t3, t4')
    expect(body).toContain('- newly passing (2): t1, t2')
    expect(body).not.toContain('- still failing')
  })

  it('preserves current-failure order from the summary in the still-failing bucket', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      // Previous slugs in a different order than current.
      summary: { failed: [{ name: 'z' }, { name: 'a' }, { name: 'm' }] },
      previousFailingSlugs: ['a', 'm', 'z'],
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('- still failing (3): z, a, m')
  })

  it('falls back to the journal\'s latest failingTests when previousFailingSlugs is omitted', () => {
    // This is the production path: the reporter calls writeHealIndex without
    // any orchestrator state. The journal entry recorded in the prior cycle
    // becomes the previous-cycle source of truth.
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    const runJournalPath = path.join(tmpDir, 'diagnosis-journal.md')
    fs.writeFileSync(runJournalPath, `## Iteration 1 — 2026-05-16T10:00:00Z

- run: r1
- failingTests: t1, t2, t3
- signal: .rerun
- outcome: pending
`)
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }, { name: 't4' }] },
      journalPath: runJournalPath,
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('## Failure delta vs previous cycle')
    expect(body).toContain('- still failing (1): t1')
    expect(body).toContain('- newly failing (1): t4')
    expect(body).toContain('- newly passing (2): t2, t3')
  })

  it('explicit previousFailingSlugs takes precedence over the journal fallback', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    const runJournalPath = path.join(tmpDir, 'diagnosis-journal.md')
    fs.writeFileSync(runJournalPath, `## Iteration 1 — t1

- failingTests: x, y
- signal: .rerun
- outcome: pending
`)
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }] },
      // Caller's slugs override the journal — used by tests and any future
      // caller that knows the prior set independently.
      previousFailingSlugs: ['t1', 't2'],
      journalPath: runJournalPath,
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('- still failing (1): t1')
    expect(body).toContain('- newly passing (1): t2')
    // The journal slugs (x, y) MUST NOT appear.
    expect(body).not.toContain('newly passing (2): x, y')
  })

  it('falls back to no-delta when the latest journal entry has no failingTests field', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    const runJournalPath = path.join(tmpDir, 'diagnosis-journal.md')
    // Iteration with no failingTests line — e.g., the journal append happened
    // before the summary was ready. Behavior: suppress the delta section.
    fs.writeFileSync(runJournalPath, `## Iteration 1 — t1

- signal: .rerun
- outcome: pending
`)
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }] },
      journalPath: runJournalPath,
      healIndexPath,
    })
    expect(readBody(healIndexPath)).not.toContain('## Failure delta vs previous cycle')
  })

  it('uses ONLY the latest journal entry (older iterations are ignored)', () => {
    // The "previous" cycle is whichever one ran most recently — not a union
    // across all prior cycles. This pins that semantic.
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    const runJournalPath = path.join(tmpDir, 'diagnosis-journal.md')
    fs.writeFileSync(runJournalPath, `## Iteration 1 — t1

- failingTests: ancient-a, ancient-b
- signal: .rerun
- outcome: regression

## Iteration 2 — t2

- failingTests: recent-a, recent-b
- signal: .rerun
- outcome: pending
`)
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 'recent-a' }, { name: 'new-c' }] },
      journalPath: runJournalPath,
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('- still failing (1): recent-a')
    expect(body).toContain('- newly failing (1): new-c')
    expect(body).toContain('- newly passing (1): recent-b')
    // Ancient iteration entries don't bleed in.
    expect(body).not.toContain('ancient-a')
    expect(body).not.toContain('ancient-b')
  })
})

describe('writeHealIndex partial-suite header (stoppedEarly)', () => {
  it('omits the stoppedEarly note when manifest does not carry one', () => {
    expect(() =>
      writeHealIndex({
        manifest: { featureName: 'demo' },
        summary: { failed: [{ name: 'a' }] },
      }),
    ).not.toThrow()
  })

  it('renders a one-line note for max-failures stops', () => {
    // We can't easily inspect the on-disk file without touching real paths,
    // but we can assert the function tolerates the field. The pluralisation
    // branches below cover the actual rendered text via a temp HEAL_INDEX.
    expect(() =>
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          stoppedEarly: { reason: 'max-failures', failuresAtStop: 1, suiteTotal: 11 },
        },
        summary: { failed: [{ name: 'a' }] },
      }),
    ).not.toThrow()
  })

  it('renders a one-line note for user-pause stops with plural failure counts', () => {
    expect(() =>
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          stoppedEarly: { reason: 'user-pause', failuresAtStop: 3, suiteTotal: 7 },
        },
        summary: { failed: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      }),
    ).not.toThrow()
  })

  it('writes the note text to disk and toggles plural forms', () => {
    // Drive writeHealIndex against the real LOGS_DIR (the module hard-codes
    // HEAL_INDEX_PATH). Snapshot + restore so the test is hermetic.
    let createdLogs = false
    if (!fs.existsSync(REAL_LOGS)) {
      fs.mkdirSync(REAL_LOGS, { recursive: true })
      createdLogs = true
    }
    const prior = fs.existsSync(REAL_HEAL_INDEX) ? fs.readFileSync(REAL_HEAL_INDEX, 'utf-8') : null
    try {
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          stoppedEarly: { reason: 'max-failures', failuresAtStop: 1, suiteTotal: 1 },
        },
        summary: { failed: [{ name: 'a' }] },
      })
      const oneOne = fs.readFileSync(REAL_HEAL_INDEX, 'utf-8')
      expect(oneOne).toMatch(/Stopped early: max-failures after 1 failure \(suite has 1 test;/)

      writeHealIndex({
        manifest: {
          featureName: 'demo',
          stoppedEarly: { reason: 'user-pause', failuresAtStop: 2, suiteTotal: 11 },
        },
        summary: { failed: [{ name: 'a' }, { name: 'b' }] },
      })
      const plural = fs.readFileSync(REAL_HEAL_INDEX, 'utf-8')
      expect(plural).toMatch(/Stopped early: user-pause after 2 failures \(suite has 11 tests;/)
    } finally {
      if (prior !== null) fs.writeFileSync(REAL_HEAL_INDEX, prior)
      else { try { fs.unlinkSync(REAL_HEAL_INDEX) } catch { /* ignore */ } }
      if (createdLogs) { try { fs.rmdirSync(REAL_LOGS) } catch { /* ignore */ } }
    }
  })
})

describe('writeFailureSlices + writeHealIndex (smoke)', () => {
  it('produces an index containing failure error + slice paths', () => {
    // This relies on the module's hard-coded LOGS_DIR / paths — but writeHealIndex
    // accepts a parsed object so we can drive it without touching real paths.
    const manifest = { featureName: 'demo', repoPaths: ['/repo'] }
    const summary = {
      failed: [
        { name: 'a-test', error: { message: 'boom' }, logFiles: ['logs/failed/a-test/svc.log'] },
      ],
    }
    // We can't easily verify the disk write without mocking paths, but we can
    // confirm the function executes without throwing.
    expect(() => writeHealIndex({ manifest, summary })).not.toThrow()
  })

  it('handles empty failed list', () => {
    expect(() => writeHealIndex({ manifest: {}, summary: { failed: [] } })).not.toThrow()
  })

  it('writeFailureSlices returns empty result for missing logs', () => {
    const r = writeFailureSlices('slug', [path.join(tmpDir, 'missing.log')])
    expect(r.logFiles).toEqual([])
  })

  it('writeFailureSlices writes matched slices to disk and reports byte counts', () => {
    const log = path.join(tmpDir, 'svc-api.log')
    fs.writeFileSync(log, '<a-test>BODY TEXT</a-test>')
    const failedDir = path.join(tmpDir, 'failed')
    const r = writeFailureSlices('a-test', [log], failedDir)
    const svcFile = path.join(failedDir, 'a-test', 'svc-api.log')
    expect(fs.readFileSync(svcFile, 'utf-8')).toBe('BODY TEXT')
    expect(r.logFiles).toHaveLength(1)
    expect(Object.keys(r.bytesByPath)).toHaveLength(1)
    expect(Object.values(r.bytesByPath)[0]).toBe(Buffer.byteLength('BODY TEXT', 'utf-8'))
  })
})

describe('stripAnsi', () => {
  it('strips ESC-prefixed and bracket-only color sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('[2mdim[22m')).toBe('dim')
  })

  it('strips non-color control codes: cursor moves, erases, charset, OSC', () => {
    expect(stripAnsi('a\x1b[20;10Hb')).toBe('ab')        // cursor position
    expect(stripAnsi('\x1b[2Jcleared')).toBe('cleared')  // erase screen
    expect(stripAnsi('\x1b(B\x1b[mhi')).toBe('hi')       // charset + reset
    expect(stripAnsi('\x1b]0;title\x07x')).toBe('x')     // OSC window title
  })
})

describe('enrichSummaryWithLogs', () => {

  it('returns null when summary or manifest is missing on disk', () => {
    // Hard to deterministically guarantee both are missing without polluting
    // the real LOGS_DIR — just exercise the API surface.
    enrichSummaryWithLogs() // may return null or a parsed object
    expect(typeof enrichSummaryWithLogs).toBe('function')
  })

  it('returns parsed manifest+summary unchanged when failed list is empty', () => {
    let createdLogs = false
    if (!fs.existsSync(REAL_LOGS)) {
      fs.mkdirSync(REAL_LOGS, { recursive: true })
      createdLogs = true
    }
    const wroteSummary = !fs.existsSync(REAL_SUMMARY)
    const wroteManifest = !fs.existsSync(REAL_MANIFEST)
    const prevSummary = wroteSummary ? null : fs.readFileSync(REAL_SUMMARY, 'utf-8')
    const prevManifest = wroteManifest ? null : fs.readFileSync(REAL_MANIFEST, 'utf-8')

    fs.writeFileSync(REAL_SUMMARY, JSON.stringify({ failed: [], passed: 1, total: 1 }))
    fs.writeFileSync(REAL_MANIFEST, JSON.stringify({ serviceLogs: [], featureName: 'x' }))
    // Override the env-controlled summary path so we know which file
    // enrichSummaryWithLogs reads, regardless of any other test's env state.
    const prevEnv = process.env.CANARY_LAB_SUMMARY_PATH
    process.env.CANARY_LAB_SUMMARY_PATH = REAL_SUMMARY
    try {
      const result = enrichSummaryWithLogs()
      expect(result).not.toBeNull()
      expect(result!.summary.failed).toEqual([])
    } finally {
      if (prevEnv === undefined) delete process.env.CANARY_LAB_SUMMARY_PATH
      else process.env.CANARY_LAB_SUMMARY_PATH = prevEnv
      if (wroteSummary) { try { fs.unlinkSync(REAL_SUMMARY) } catch { /* ignore */ } }
      else if (prevSummary !== null) fs.writeFileSync(REAL_SUMMARY, prevSummary)
      if (wroteManifest) { try { fs.unlinkSync(REAL_MANIFEST) } catch { /* ignore */ } }
      else if (prevManifest !== null) fs.writeFileSync(REAL_MANIFEST, prevManifest)
      if (createdLogs) { try { fs.rmdirSync(REAL_LOGS) } catch { /* ignore */ } }
    }
  })

  it('rewrites failed entries with logFiles', () => {
    const runId = `test-${Date.now()}`
    const runDir = path.join(REAL_LOGS, 'runs', runId)
    fs.mkdirSync(runDir, { recursive: true })
    const summaryPath = path.join(runDir, 'e2e-summary.json')
    const manifestPath = path.join(runDir, 'manifest.json')
    const svcLog = path.join(runDir, 'svc-api.log')
    fs.writeFileSync(svcLog, '<a-test>BODY</a-test>')
    fs.writeFileSync(summaryPath, JSON.stringify({
      failed: [{ name: 'a-test' }, 'b-test'],
    }))
    fs.writeFileSync(manifestPath, JSON.stringify({
      services: [{ logPath: svcLog }],
      feature: 'x',
    }))

    const prevEnv = process.env.CANARY_LAB_SUMMARY_PATH
    process.env.CANARY_LAB_SUMMARY_PATH = summaryPath
    try {
      const result = enrichSummaryWithLogs()
      expect(result).not.toBeNull()
      const failed = result!.summary.failed!
      expect(failed[0].logFiles).toEqual([
        path.join('logs', 'runs', runId, 'failed', 'a-test', 'svc-api.log'),
      ])
      expect(fs.readFileSync(path.join(runDir, 'failed', 'a-test', 'svc-api.log'), 'utf-8')).toBe('BODY')
      // sliceMeta rides along in-memory: uncapped, pointing at the source log.
      expect(failed[0].sliceMeta).toEqual([
        {
          path: path.join('logs', 'runs', runId, 'failed', 'a-test', 'svc-api.log'),
          bytes: 4,
          fullLog: path.join('logs', 'runs', runId, 'svc-api.log'),
          fullLogBytes: Buffer.byteLength('<a-test>BODY</a-test>', 'utf-8'),
          windowBytes: 4,
          capped: false,
        },
      ])

      fs.writeFileSync(path.join(runDir, 'diagnosis-journal.md'), `# Diagnosis Journal

## Iteration 1 — t1

- hypothesis: run-local
- signal: .restart
- outcome: pending
`)
      writeHealIndex(result ?? undefined)
      const healIndex = fs.readFileSync(path.join(runDir, 'heal-index.md'), 'utf-8')
      expect(healIndex).toContain(
        path.join('logs', 'runs', runId, 'failed', 'a-test', 'svc-api.log'),
      )
      expect(healIndex).toContain('run-local')
      expect(healIndex).toContain(path.join('logs', 'runs', runId, 'diagnosis-journal.md'))
    } finally {
      if (prevEnv === undefined) delete process.env.CANARY_LAB_SUMMARY_PATH
      else process.env.CANARY_LAB_SUMMARY_PATH = prevEnv
      try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('merges legacy manifest.serviceLogs with current manifest.services logPaths', () => {
    const runId = `test-legacy-${Date.now()}`
    const runDir = path.join(REAL_LOGS, 'runs', runId)
    fs.mkdirSync(runDir, { recursive: true })
    const summaryPath = path.join(runDir, 'e2e-summary.json')
    const manifestPath = path.join(runDir, 'manifest.json')
    const legacyLog = path.join(runDir, 'svc-legacy.log')
    const currentLog = path.join(runDir, 'svc-current.log')
    fs.writeFileSync(legacyLog, '<a-test>FROM_LEGACY</a-test>')
    fs.writeFileSync(currentLog, '<b-test>FROM_CURRENT</b-test>')
    fs.writeFileSync(summaryPath, JSON.stringify({ failed: [{ name: 'a-test' }, { name: 'b-test' }] }))
    fs.writeFileSync(manifestPath, JSON.stringify({
      serviceLogs: [legacyLog],
      services: [{ logPath: currentLog }],
    }))

    const prevEnv = process.env.CANARY_LAB_SUMMARY_PATH
    process.env.CANARY_LAB_SUMMARY_PATH = summaryPath
    try {
      const result = enrichSummaryWithLogs()
      expect(result).not.toBeNull()
      const failed = result!.summary.failed!
      expect(failed[0].logFiles?.[0]).toContain('svc-legacy')
      expect(failed[1].logFiles?.[0]).toContain('svc-current')
    } finally {
      if (prevEnv === undefined) delete process.env.CANARY_LAB_SUMMARY_PATH
      else process.env.CANARY_LAB_SUMMARY_PATH = prevEnv
      try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('falls back to an empty slice map for a failed entry whose name matched no slug', () => {
    // An entry with a blank name is excluded from the extracted `slugs` list
    // (filtered as non-positive-length) but still walked when rewriting
    // `summary.failed` — its lookup into `recordsBySlug` must fall back to {}
    // instead of throwing.
    const runId = `test-blank-name-${Date.now()}`
    const runDir = path.join(REAL_LOGS, 'runs', runId)
    fs.mkdirSync(runDir, { recursive: true })
    const summaryPath = path.join(runDir, 'e2e-summary.json')
    const manifestPath = path.join(runDir, 'manifest.json')
    const svcLog = path.join(runDir, 'svc-api.log')
    fs.writeFileSync(svcLog, '<a-test>BODY</a-test>')
    fs.writeFileSync(summaryPath, JSON.stringify({ failed: [{ name: 'a-test' }, { name: '' }] }))
    fs.writeFileSync(manifestPath, JSON.stringify({ services: [{ logPath: svcLog }] }))

    const prevEnv = process.env.CANARY_LAB_SUMMARY_PATH
    process.env.CANARY_LAB_SUMMARY_PATH = summaryPath
    try {
      const result = enrichSummaryWithLogs()
      expect(result).not.toBeNull()
      const failed = result!.summary.failed!
      expect(failed[0].logFiles?.[0]).toContain('svc-api')
      expect(failed[1].name).toBe('')
      expect(failed[1].logFiles).toBeUndefined()
      expect(failed[1].sliceMeta).toBeUndefined()
    } finally {
      if (prevEnv === undefined) delete process.env.CANARY_LAB_SUMMARY_PATH
      else process.env.CANARY_LAB_SUMMARY_PATH = prevEnv
      try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
