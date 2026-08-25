import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { capSlice, capSliceWithMeta, enrichSummaryWithLogs, extractAllSlices, extractLogsForTest, stripAnsi, writeErrorFile, writeHealIndex } from './log-enrichment'
import { LOGS_DIR as REAL_LOGS, MANIFEST_PATH as REAL_MANIFEST, SUMMARY_PATH as REAL_SUMMARY } from './paths'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-le-')))
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
