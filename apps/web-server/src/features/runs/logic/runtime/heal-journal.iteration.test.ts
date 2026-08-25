import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MAX_JOURNAL_DIFF_BYTES, appendJournalIteration, writeFullDiffPatch } from './heal-journal'
import { DIAGNOSIS_JOURNAL_PATH as REAL_JOURNAL, LOGS_DIR as REAL_LOGS, MANIFEST_PATH as REAL_MANIFEST, SUMMARY_PATH as REAL_SUMMARY } from './paths'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-le-')))
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
