import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  detectMigrations,
  applyArchive,
  renderReport,
  hasPendingMigrations,
  findOrphanedLogs,
  findStaleFeatureConfigs,
  lintFeatureConfig,
  extractHealPrompt,
  compareHealPrompt,
  findOldPathReferences,
} from './upgrade-migration'
import { KNOWN_OLD_HEAL_PROMPTS } from './upgrade-known-prompts'

const tmpDirs: string[] = []
function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mig-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

const TEMPLATE_BODY = `Playwright failed. Fix service/app code, not tests.

After fixing, write \`logs/.restart\` or \`logs/.rerun\`.`

describe('findOrphanedLogs', () => {
  it('returns empty when logs/ is missing', () => {
    expect(findOrphanedLogs(mkRepo())).toEqual([])
  })

  it('finds svc-*.log, heal-index.md, e2e-summary.json, manifest.json at top level', () => {
    const repo = mkRepo()
    const logs = path.join(repo, 'logs')
    fs.mkdirSync(logs)
    fs.writeFileSync(path.join(logs, 'svc-api.log'), 'x')
    fs.writeFileSync(path.join(logs, 'heal-index.md'), 'x')
    fs.writeFileSync(path.join(logs, 'e2e-summary.json'), '{}')
    fs.writeFileSync(path.join(logs, 'manifest.json'), '{}')
    const orphans = findOrphanedLogs(repo)
    expect(orphans.map((p) => path.basename(p)).sort()).toEqual([
      'e2e-summary.json',
      'heal-index.md',
      'manifest.json',
      'svc-api.log',
    ])
  })

  it('does NOT include diagnosis-journal.md', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'logs'))
    fs.writeFileSync(path.join(repo, 'logs', 'diagnosis-journal.md'), 'persistent')
    expect(findOrphanedLogs(repo)).toEqual([])
  })

  it('does NOT include files inside logs/runs/<id>/ or logs/_pre-0.10.x-archive/', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'logs', 'runs', 'abc'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'logs', '_pre-0.10.x-archive', 'old'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'logs', 'runs', 'abc', 'svc-x.log'), 'x')
    fs.writeFileSync(path.join(repo, 'logs', '_pre-0.10.x-archive', 'old', 'svc-y.log'), 'y')
    expect(findOrphanedLogs(repo)).toEqual([])
  })

  it('ignores unrelated files (e.g. .DS_Store)', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'logs'))
    fs.writeFileSync(path.join(repo, 'logs', '.DS_Store'), '')
    fs.writeFileSync(path.join(repo, 'logs', 'something-else.txt'), '')
    expect(findOrphanedLogs(repo)).toEqual([])
  })
})

describe('lintFeatureConfig / findStaleFeatureConfigs', () => {
  function writeConfig(repo: string, name: string, body: string): string {
    const dir = path.join(repo, 'features', name)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'feature.config.cjs')
    fs.writeFileSync(p, body)
    return p
  }

  it('flags `launcher` field', () => {
    const repo = mkRepo()
    const p = writeConfig(repo, 'foo', "module.exports.config = { name: 'foo', description: 'd', envs: ['x'], launcher: 'iterm' }")
    const issues = lintFeatureConfig(p)
    expect(issues.join(' ')).toMatch(/launcher/)
  })

  it('flags missing description and envs', () => {
    const repo = mkRepo()
    const p = writeConfig(repo, 'bar', "module.exports.config = { name: 'bar' }")
    const issues = lintFeatureConfig(p)
    expect(issues.join(' ')).toMatch(/description/)
    expect(issues.join(' ')).toMatch(/envs/)
  })

  it('returns no issues for a clean config', () => {
    const repo = mkRepo()
    const p = writeConfig(repo, 'baz', "module.exports.config = { name: 'baz', description: 'd', envs: ['x'] }")
    expect(lintFeatureConfig(p)).toEqual([])
  })

  it('returns failed-to-load when config throws', () => {
    const repo = mkRepo()
    const p = writeConfig(repo, 'broken', 'throw new Error("boom")')
    const issues = lintFeatureConfig(p)
    expect(issues[0]).toMatch(/failed to load/)
  })

  it('returns export-not-object when module is not an object', () => {
    const repo = mkRepo()
    const p = writeConfig(repo, 'wat', "module.exports.config = 42")
    const issues = lintFeatureConfig(p)
    expect(issues[0]).toMatch(/not an object/)
  })

  it('findStaleFeatureConfigs walks features/* and only includes configs with issues', () => {
    const repo = mkRepo()
    writeConfig(repo, 'clean', "module.exports.config = { name: 'clean', description: 'd', envs: ['x'] }")
    writeConfig(repo, 'dirty', "module.exports.config = { name: 'dirty', description: 'd', envs: ['x'], launcher: 'terminal' }")
    // A non-feature dir should be ignored too
    fs.mkdirSync(path.join(repo, 'features', 'no-config'))
    const stale = findStaleFeatureConfigs(repo)
    expect(stale).toHaveLength(1)
    expect(stale[0].path).toContain('dirty')
  })

  it('findStaleFeatureConfigs returns [] when features/ is missing', () => {
    expect(findStaleFeatureConfigs(mkRepo())).toEqual([])
  })

  it('findStaleFeatureConfigs ignores stray files inside features/', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'features'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'features', 'README.md'), 'not a feature dir')
    expect(findStaleFeatureConfigs(repo)).toEqual([])
  })

  it('uses module.exports.default fallback for config shape', () => {
    const repo = mkRepo()
    const dir = path.join(repo, 'features', 'def')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'feature.config.cjs')
    fs.writeFileSync(
      p,
      "module.exports.default = { name: 'def', description: 'd', envs: ['x'], launcher: 'iterm' }",
    )
    const issues = lintFeatureConfig(p)
    expect(issues.join(' ')).toMatch(/launcher/)
  })

  it('flags description present but non-string', () => {
    const repo = mkRepo()
    const dir = path.join(repo, 'features', 'numdesc')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'feature.config.cjs')
    fs.writeFileSync(p, "module.exports.config = { name: 'n', description: 42, envs: ['x'] }")
    expect(lintFeatureConfig(p).join(' ')).toMatch(/description/)
  })

  it('flags description present but empty string', () => {
    const repo = mkRepo()
    const dir = path.join(repo, 'features', 'emptydesc')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'feature.config.cjs')
    fs.writeFileSync(p, "module.exports.config = { name: 'n', description: '', envs: ['x'] }")
    expect(lintFeatureConfig(p).join(' ')).toMatch(/description/)
  })

  it('flags envs present but not an array', () => {
    const repo = mkRepo()
    const dir = path.join(repo, 'features', 'envstr')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'feature.config.cjs')
    fs.writeFileSync(p, "module.exports.config = { name: 'n', description: 'd', envs: 'x' }")
    expect(lintFeatureConfig(p).join(' ')).toMatch(/envs/)
  })

  it('uses bare module.exports as a last resort', () => {
    const repo = mkRepo()
    const dir = path.join(repo, 'features', 'bare')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'feature.config.cjs')
    fs.writeFileSync(
      p,
      "module.exports = { name: 'bare', description: 'd', envs: ['x'] }",
    )
    expect(lintFeatureConfig(p)).toEqual([])
  })
})

describe('extractHealPrompt / compareHealPrompt', () => {
  it('extractHealPrompt returns null when markers missing', () => {
    expect(extractHealPrompt('no markers')).toBeNull()
    expect(extractHealPrompt('<!-- heal-prompt:start --> only one')).toBeNull()
  })

  it('extractHealPrompt returns trimmed body between markers', () => {
    const md = `prefix\n<!-- heal-prompt:start -->\n  body line\n<!-- heal-prompt:end -->\nsuffix`
    expect(extractHealPrompt(md)).toBe('body line')
  })

  it('matches-current when bodies match exactly', () => {
    const md = `<!-- heal-prompt:start -->\n${TEMPLATE_BODY}\n<!-- heal-prompt:end -->`
    const r = compareHealPrompt(md, TEMPLATE_BODY)
    expect(r.status).toBe('matches-current')
    expect(r.diff).toBeUndefined()
  })

  it('matches-old-exact for known prior version verbatim', () => {
    const old = KNOWN_OLD_HEAL_PROMPTS[0].body
    const md = `<!-- heal-prompt:start -->\n${old}\n<!-- heal-prompt:end -->`
    const r = compareHealPrompt(md, TEMPLATE_BODY)
    expect(r.status).toBe('matches-old-exact')
    expect(r.diff).toContain('--- current')
  })

  it('customized when neither matches', () => {
    const md = `<!-- heal-prompt:start -->\nMy custom prompt with extra rules.\n<!-- heal-prompt:end -->`
    const r = compareHealPrompt(md, TEMPLATE_BODY)
    expect(r.status).toBe('customized')
    expect(r.diff).toBeDefined()
  })

  it('matches-current when CLAUDE.md is empty (fresh install)', () => {
    expect(compareHealPrompt('', TEMPLATE_BODY).status).toBe('matches-current')
  })

  it('customized with note when CLAUDE.md has no markers at all', () => {
    const r = compareHealPrompt('# Some doc\nno markers', TEMPLATE_BODY)
    expect(r.status).toBe('customized')
    expect(r.note).toMatch(/markers/)
  })
})

describe('findOldPathReferences', () => {
  it('returns [] for empty input', () => {
    expect(findOldPathReferences('')).toEqual([])
  })

  it('parses path:line:content lines', () => {
    const out = findOldPathReferences(
      `.github/workflows/canary.yml:42:    cat logs/heal-index.md\nscripts/check.sh:15:tail logs/svc-api.log`,
    )
    expect(out).toEqual([
      { file: '.github/workflows/canary.yml', line: 42, content: '    cat logs/heal-index.md' },
      { file: 'scripts/check.sh', line: 15, content: 'tail logs/svc-api.log' },
    ])
  })

  it('skips Binary file lines and malformed rows', () => {
    const out = findOldPathReferences(
      `Binary file ./foo matches\nno-colons-here\nfoo:notanumber:line\nfoo:7:ok`,
    )
    expect(out).toEqual([{ file: 'foo', line: 7, content: 'ok' }])
  })

  it('skips lines with non-positive line numbers', () => {
    expect(findOldPathReferences('foo:0:x\nfoo:-1:y')).toEqual([])
  })

  it('skips lines with only one colon (missing content separator)', () => {
    expect(findOldPathReferences('foo:bar')).toEqual([])
  })
})

describe('detectMigrations', () => {
  it('clean repo (no logs, no features)', () => {
    const repo = mkRepo()
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    expect(r.orphanedLogs).toEqual([])
    expect(r.staleFeatureConfigs).toEqual([])
    expect(r.healPromptStatus).toBe('matches-current')
    expect(r.ciPathHints).toEqual([])
    expect(hasPendingMigrations(r)).toBe(false)
  })

  it('repo with diagnosis-journal.md only is clean', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'logs'))
    fs.writeFileSync(path.join(repo, 'logs', 'diagnosis-journal.md'), 'x')
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    expect(r.orphanedLogs).toEqual([])
    expect(hasPendingMigrations(r)).toBe(false)
  })

  it('repo with logs/runs/<id>/ only is clean', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'logs', 'runs', 'r1'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'logs', 'runs', 'r1', 'svc-a.log'), 'x')
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    expect(r.orphanedLogs).toEqual([])
    expect(hasPendingMigrations(r)).toBe(false)
  })

  it('repo with orphans is pending', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'logs'))
    fs.writeFileSync(path.join(repo, 'logs', 'svc-api.log'), 'big content here')
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    expect(r.orphanedLogs).toHaveLength(1)
    expect(hasPendingMigrations(r)).toBe(true)
  })

  it('repo with old heal-prompt verbatim flags matches-old-exact', () => {
    const repo = mkRepo()
    const oldBody = KNOWN_OLD_HEAL_PROMPTS[0].body
    fs.writeFileSync(
      path.join(repo, 'CLAUDE.md'),
      `<!-- heal-prompt:start -->\n${oldBody}\n<!-- heal-prompt:end -->`,
    )
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    expect(r.healPromptStatus).toBe('matches-old-exact')
    expect(r.healPromptDiff).toBeDefined()
  })

  it('repo with customized heal-prompt flags customized', () => {
    const repo = mkRepo()
    fs.writeFileSync(
      path.join(repo, 'CLAUDE.md'),
      `<!-- heal-prompt:start -->\nuser-edited\n<!-- heal-prompt:end -->`,
    )
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    expect(r.healPromptStatus).toBe('customized')
  })

  it('finds CI script hints via grep', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, '.github', 'workflows', 'canary.yml'),
      'jobs:\n  go:\n    run: cat logs/heal-index.md\n',
    )
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    expect(r.ciPathHints.length).toBeGreaterThan(0)
    expect(r.ciPathHints[0].file).toContain('canary.yml')
    expect(r.ciPathHints[0].content).toMatch(/heal-index/)
  })

  it('lints stale feature.config.cjs', () => {
    const repo = mkRepo()
    const dir = path.join(repo, 'features', 'has-launcher')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      "module.exports.config = { name: 'x', description: 'd', envs: ['e'], launcher: 'iterm' }",
    )
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    expect(r.staleFeatureConfigs).toHaveLength(1)
    expect(hasPendingMigrations(r)).toBe(true)
  })

  it('loads template heal-prompt from disk when not injected', () => {
    // No injection — uses bundled template via __dirname resolution.
    const repo = mkRepo()
    const r = detectMigrations(repo)
    // Whatever the bundled template says, an empty CLAUDE.md → matches-current.
    expect(r.healPromptStatus).toBe('matches-current')
  })
})

describe('applyArchive', () => {
  it('moves orphaned files into a timestamped archive dir', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, 'logs'))
    fs.writeFileSync(path.join(repo, 'logs', 'svc-api.log'), 'a')
    fs.writeFileSync(path.join(repo, 'logs', 'heal-index.md'), 'h')
    fs.writeFileSync(path.join(repo, 'logs', 'diagnosis-journal.md'), 'keep me')
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    applyArchive(r, repo)

    expect(r.archivedFiles).toHaveLength(2)
    expect(fs.existsSync(path.join(repo, 'logs', 'svc-api.log'))).toBe(false)
    expect(fs.existsSync(path.join(repo, 'logs', 'heal-index.md'))).toBe(false)
    expect(fs.existsSync(path.join(repo, 'logs', 'diagnosis-journal.md'))).toBe(true)

    const archiveRoot = path.join(repo, 'logs', '_pre-0.10.x-archive')
    expect(fs.existsSync(archiveRoot)).toBe(true)
    const tsDirs = fs.readdirSync(archiveRoot)
    expect(tsDirs).toHaveLength(1)
    expect(tsDirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}$/)
    const archived = fs.readdirSync(path.join(archiveRoot, tsDirs[0])).sort()
    expect(archived).toEqual(['heal-index.md', 'svc-api.log'])
  })

  it('is a no-op when there are no orphans', () => {
    const repo = mkRepo()
    const r = detectMigrations(repo, { templateHealPromptBody: TEMPLATE_BODY })
    applyArchive(r, repo)
    expect(r.archivedFiles).toEqual([])
    expect(fs.existsSync(path.join(repo, 'logs', '_pre-0.10.x-archive'))).toBe(false)
  })
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
