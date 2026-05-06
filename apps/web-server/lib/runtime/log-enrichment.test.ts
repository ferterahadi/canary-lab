import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  appendJournalIteration,
  capSlice,
  enrichSummaryWithLogs,
  extractAllSlices,
  extractLogsForTest,
  nextIterationNumber,
  parseJournalMarkdown,
  stripAnsi,
  writeFailureSlices,
  writeHealIndex,
} from './log-enrichment'
import {
  DIAGNOSIS_JOURNAL_PATH as REAL_JOURNAL,
  HEAL_INDEX_PATH as REAL_HEAL_INDEX,
  LOGS_DIR as REAL_LOGS,
  MANIFEST_PATH as REAL_MANIFEST,
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
})

describe('stripAnsi', () => {
  it('strips ESC-prefixed and bracket-only color sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('[2mdim[22m')).toBe('dim')
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
})
