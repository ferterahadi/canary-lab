import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-summary-paths-'))
const legacy = path.join(root, 'logs')
vi.mock('./paths', () => ({
  ROOT: root,
  LOGS_DIR: legacy,
  SUMMARY_PATH: path.join(legacy, 'e2e-summary.json'),
  MANIFEST_PATH: path.join(legacy, 'manifest.json'),
  HEAL_INDEX_PATH: path.join(legacy, 'heal-index.md'),
  DIAGNOSIS_JOURNAL_PATH: path.join(legacy, 'diagnosis-journal.md'),
  FAILED_DIR: path.join(legacy, 'failed'),
  getSummaryPath: () => process.env.CANARY_LAB_SUMMARY_PATH ?? path.join(legacy, 'e2e-summary.json'),
}))
const { journalPathForSummary, runIdForSummary } = await import('./summary-locations')
const { enrichSummaryWithLogs } = await import('./log-enrichment')
const { writeHealIndex } = await import('./heal-index')
const { appendJournalIteration } = await import('./heal-journal')
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(legacy, { recursive: true, force: true }) })
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function seed(dir: string, filename = 'e2e-summary.json') {
  fs.mkdirSync(dir, { recursive: true })
  const summaryPath = path.join(dir, filename)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId: path.basename(dir), feature: 'fixture', services: [] }))
  fs.writeFileSync(summaryPath, JSON.stringify({ failed: [{ name: 'fixture-test', error: { message: 'fixture failure' } }] }))
  appendJournalIteration({ manifestPath: path.join(dir, 'manifest.json'), summaryPath,
    journalPath: path.join(dir, 'diagnosis-journal.md'), hypothesis: `marker-${path.basename(dir)}`, signal: '.rerun' })
  return summaryPath
}

it('uses legacy paths and resolves summary and manifest overrides at each call', () => {
  seed(legacy)
  expect(journalPathForSummary()).toBe(path.join(legacy, 'diagnosis-journal.md'))
  expect(runIdForSummary()).toBe('logs')
  const run = path.join(legacy, 'runs', 'run-a')
  vi.stubEnv('CANARY_LAB_SUMMARY_PATH', seed(run, 'custom.json'))
  expect(journalPathForSummary()).toBe(path.join(run, 'diagnosis-journal.md'))
  expect(runIdForSummary()).toBe('run-a')
  vi.stubEnv('CANARY_LAB_MANIFEST_PATH', path.join(legacy, 'manifest.json'))
  expect(runIdForSummary()).toBe('logs')
  vi.stubEnv('CANARY_LAB_MANIFEST_PATH', '')
  expect(runIdForSummary()).toBeUndefined()
})

it('enriches the authored summary and sibling artifacts despite a different manifest override', () => {
  seed(legacy)
  const run = path.join(legacy, 'runs', 'run-b')
  const summaryPath = seed(run, 'authored-name.json')
  vi.stubEnv('CANARY_LAB_SUMMARY_PATH', summaryPath)
  vi.stubEnv('CANARY_LAB_MANIFEST_PATH', path.join(legacy, 'manifest.json'))
  const enriched = enrichSummaryWithLogs()!
  expect(enriched.manifest).toMatchObject({ runId: 'run-b' })
  expect(enriched.summaryPath).toBe(summaryPath)
  expect(enriched.journalPath).toBe(path.join(run, 'diagnosis-journal.md'))
  expect(enriched.healIndexPath).toBe(path.join(run, 'heal-index.md'))
  expect(fs.readFileSync(path.join(run, 'failed', 'fixture-test', 'error.txt'), 'utf-8')).toContain('fixture failure')
  expect(JSON.parse(fs.readFileSync(summaryPath, 'utf-8')).failed[0].errorFile).toBe('logs/runs/run-b/failed/fixture-test/error.txt')
  expect(fs.existsSync(path.join(run, 'e2e-summary.json'))).toBe(false)
  writeHealIndex()
  expect(fs.readFileSync(enriched.healIndexPath, 'utf-8')).toContain('marker-run-b')
})

it('preserves parsed-data defaults and explicit index and journal overrides', () => {
  seed(legacy)
  const run = path.join(legacy, 'runs', 'run-c')
  const summaryPath = seed(run, 'custom.json')
  const parsed = { manifest: { feature: 'fixture', services: [] }, summary: { failed: [] }, summaryPath }
  writeHealIndex(parsed)
  expect(fs.readFileSync(path.join(legacy, 'heal-index.md'), 'utf-8')).toContain('marker-run-c')
  expect(fs.existsSync(path.join(run, 'heal-index.md'))).toBe(false)
  const target = path.join(run, 'explicit-index.md')
  writeHealIndex({ ...parsed, healIndexPath: target, journalPath: path.join(legacy, 'diagnosis-journal.md') })
  expect(fs.readFileSync(target, 'utf-8')).toContain('marker-logs')
  expect(fs.readFileSync(target, 'utf-8')).not.toContain('marker-run-c')
})

it('keeps relative paths relative and computes absent journal paths without creating directories', () => {
  const dir = path.relative(process.cwd(), path.join(legacy, 'runs', 'relative'))
  vi.stubEnv('CANARY_LAB_SUMMARY_PATH', path.join(dir, 'custom.json'))
  expect(journalPathForSummary()).toBe(path.join(dir, 'diagnosis-journal.md'))
  expect(path.isAbsolute(journalPathForSummary())).toBe(false)
  expect(fs.existsSync(dir)).toBe(false)
})
