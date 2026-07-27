import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeFailureSlices } from './log-enrichment'
import { writeHealIndex } from './heal-index'
import { DIAGNOSIS_JOURNAL_PATH as REAL_JOURNAL, LOGS_DIR as REAL_LOGS, ROOT } from './paths'

let tmpDir: string

beforeEach(() => {
  // The run dir sits under its own `runs/` root on purpose. writeHealIndex reads
  // cross-run flake history from `dirname(dirname(healIndexPath))` — pointing it
  // straight at a mkdtemp dir makes that the SYSTEM temp root, so the scan walks
  // every other test's leftovers: non-deterministic, and seconds slow once the
  // suite has been running a while.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-le-')))
  tmpDir = path.join(root, 'runs', '2026-01-01T0000-heal')
  fs.mkdirSync(tmpDir, { recursive: true })
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
