import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  detectMigrations,
  applyArchive,
  renderReport,
  hasPendingMigrations,
  findOrphanedLogs,
  findLegacyCurrentPointer,
  findStaleFeatureConfigs,
  lintFeatureConfig,
  extractHealPrompt,
  compareHealPrompt,
  findOldPathReferences,
  loadTemplateHealPrompt,
  removeLegacyCurrentPointer,
} from './upgrade-migration'

const tmpDirs: string[] = []

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mig-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('renderReport', () => {
  function baseReport() {
    return {
      archivedFiles: [],
      orphanedLogs: [],
      staleFeatureConfigs: [],
      healPromptStatus: 'matches-current' as const,
      ciPathHints: [],
    }
  }

  it('renders all-clean output with checkmarks', () => {
    const out = renderReport(baseReport())
    expect(out).toContain('No orphaned 0.9.x logs')
    expect(out).toContain('All feature.config.cjs files look clean')
    expect(out).toContain('Heal prompt in CLAUDE.md is up to date')
    expect(out).toContain('No CI scripts referencing old log paths')
  })

  it('renders legacy current pointer warning and removal', () => {
    const warning = renderReport({
      ...baseReport(),
      legacyCurrentPointer: '/repo/logs/current',
    })
    expect(warning).toContain('Found legacy active-run pointer')

    const removed = renderReport({
      ...baseReport(),
      legacyCurrentPointer: '/repo/logs/current',
      removedLegacyCurrentPointer: '/repo/logs/current',
    })
    expect(removed).toContain('Removed legacy active-run pointer')
  })

  it('renders orphaned-logs warning when orphans pending', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'logs'))
    const p = path.join(repo, 'logs', 'svc-api.log')
    fs.writeFileSync(p, 'x'.repeat(2000))
    const out = renderReport({ ...baseReport(), orphanedLogs: [p] })
    expect(out).toMatch(/Found 1 orphaned/)
    expect(out).toMatch(/svc-api\.log/)
    expect(out).toMatch(/KB|B/)
  })

  it('renders archived list after applyArchive', () => {
    const out = renderReport({ ...baseReport(), archivedFiles: ['/x/y/z.log'] })
    expect(out).toMatch(/Archived 1 orphaned/)
    expect(out).toContain('/x/y/z.log')
  })

  it('renders stale feature configs', () => {
    const out = renderReport({
      ...baseReport(),
      staleFeatureConfigs: [{ path: 'features/foo/feature.config.cjs', issues: ['dropped field: launcher'] }],
    })
    expect(out).toMatch(/feature\.config\.cjs file\(s\) have issues/)
    expect(out).toContain('dropped field: launcher')
  })

  it('renders matches-old-exact diff', () => {
    const out = renderReport({
      ...baseReport(),
      healPromptStatus: 'matches-old-exact',
      healPromptDiff: '--- old\n+++ new',
    })
    expect(out).toMatch(/matches a known prior version/)
    expect(out).toContain('--- old')
  })

  it('renders matches-old-exact without a diff (defensive branch)', () => {
    const out = renderReport({
      ...baseReport(),
      healPromptStatus: 'matches-old-exact',
    })
    expect(out).toMatch(/matches a known prior version/)
  })

  it('renders customized without note or diff (defensive branch)', () => {
    const out = renderReport({
      ...baseReport(),
      healPromptStatus: 'customized',
    })
    expect(out).toMatch(/customized or missing/)
  })

  it('renders customized status with note and diff', () => {
    const out = renderReport({
      ...baseReport(),
      healPromptStatus: 'customized',
      healPromptNote: 'markers missing',
      healPromptDiff: 'd',
    })
    expect(out).toMatch(/customized or missing/)
    expect(out).toContain('markers missing')
  })

  it('renders CI hints when present', () => {
    const out = renderReport({
      ...baseReport(),
      ciPathHints: [{ file: '.github/workflows/x.yml', line: 12, content: 'cat logs/heal-index.md' }],
    })
    expect(out).toContain('.github/workflows/x.yml:12')
    expect(out).toContain('logs/heal-index.md')
  })

  it('handles missing-orphan stat gracefully (formatSize falls through)', () => {
    const out = renderReport({
      ...baseReport(),
      orphanedLogs: ['/nonexistent/path/svc-x.log'],
    })
    expect(out).toContain('/nonexistent/path/svc-x.log')
  })

  it('returns an empty string when loadTemplateHealPrompt finds no template', () => {
    expect(loadTemplateHealPrompt(['/no/such/template.md'])).toBe('')
  })

  it('returns an empty string when loadTemplateHealPrompt template lacks heal section', () => {
    const repo = mkRepo()
    const stub = path.join(repo, 'CLAUDE.md')
    fs.writeFileSync(stub, '# nothing\n\nno heal section here\n')
    expect(loadTemplateHealPrompt([stub])).toBe('')
  })

  it('renders B / KB / MB size buckets for orphan files', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'logs'))
    const tiny = path.join(repo, 'logs', 'svc-tiny.log')
    const kb = path.join(repo, 'logs', 'svc-kb.log')
    const mb = path.join(repo, 'logs', 'svc-mb.log')
    fs.writeFileSync(tiny, 'x'.repeat(10))
    fs.writeFileSync(kb, 'x'.repeat(2000))
    fs.writeFileSync(mb, 'x'.repeat(1024 * 1024 + 10))
    const out = renderReport({ ...baseReport(), orphanedLogs: [tiny, kb, mb] })
    expect(out).toContain('10 B')
    expect(out).toMatch(/2\.0 KB|1\.9 KB/)
    expect(out).toMatch(/1\.0 MB/)
  })
})
