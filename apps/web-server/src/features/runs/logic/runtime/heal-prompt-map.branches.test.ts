import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildHealPromptMap, buildOrchestratorHealPrompt } from './auto-heal'

function writeRunManifest(runDir: string, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    runId: 'r1',
    feature: 'f',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'running',
    healCycles: 0,
    services: [],
    ...body,
  }))
}

describe('auto-heal branch edge cases', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-edge-')))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('buildHealPromptMap: runDirRel falls back to runDir when projectRoot === runDir', () => {
    // path.relative(x, x) === '' so the `|| opts.runDir` branch is taken.
    const runDir = tmp
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })
    const map = buildHealPromptMap({ projectRoot: runDir, runDir })
    expect(map.runDirRel).toBe(runDir)
  })

  it('buildOrchestratorHealPrompt: runDirRel falls back to runDir when projectRoot === runDir', () => {
    const runDir = tmp
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot: runDir, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    // Renders `<runDir> (`<runDir>` from the project root)` — RHS of the `||`.
    expect(prompt).toContain(`Run directory:\n- \`${runDir}\` (\`${runDir}\` from the project root)`)
  })

  it('skips a stray non-directory entry alongside failure dirs (failure-log / trace / mcp scans)', () => {
    const runDir = path.join(tmp, 'run')
    const failedDir = path.join(runDir, 'failed')
    fs.mkdirSync(failedDir, { recursive: true })
    // Stray file directly under failedDir — must be skipped by `!isDirectory()`.
    // Named so it sorts BEFORE the real failure dir; readdirSync yields it
    // first, so the `!isDirectory() continue` runs before the dir match returns.
    fs.writeFileSync(path.join(failedDir, '0-stray.txt'), 'not a dir')
    // A real failure dir with all three artifact kinds so the scans iterate
    // past the stray file and still find the directory entry.
    const slug = path.join(failedDir, 'case-1')
    fs.mkdirSync(path.join(slug, 'trace-extract'), { recursive: true })
    fs.writeFileSync(path.join(slug, 'api.log'), 'slice')
    fs.writeFileSync(path.join(slug, 'trace-extract', 'failure-summary.md'), 'trace')
    fs.mkdirSync(path.join(slug, 'playwright-mcp'), { recursive: true })
    fs.writeFileSync(path.join(slug, 'playwright-mcp', 'snap.png'), 'png')
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })

    const map = buildHealPromptMap({ projectRoot: tmp, runDir })
    const ids = map.resources.map((r) => r.id)
    // failed-slices (hasAnyFailureLog), trace-extract (hasAnyFailureWith),
    // playwright-mcp (hasAnyFailureWithNonEmptyDir) all reached past the stray.
    expect(ids).toContain('failed-slices')
    expect(ids).toContain('trace-extract')
    expect(ids).toContain('playwright-mcp')
  })

  it('featureDocsDir returns null when the docs dir is missing (directoryExists catch)', () => {
    // featureDir set but no `docs` subdir → statSync throws → directoryExists
    // returns false via its catch → no feature-docs resource.
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    const featureDir = path.join(tmp, 'features', 'no_docs')
    fs.mkdirSync(featureDir, { recursive: true })
    writeRunManifest(runDir, { featureDir, repoPaths: ['/repo/app'] })

    const map = buildHealPromptMap({ projectRoot: tmp, runDir })
    expect(map.resources.map((r) => r.id)).not.toContain('feature-docs')
  })

  it('renderPromptTemplate keeps a placeholder-only line whose key is absent from values', () => {
    // Custom template with a placeholder-only line referencing a key that is
    // NOT in the values map buildOrchestratorHealPrompt passes. Only a KNOWN
    // key resolving to '' drops its solo line; an unrecognized placeholder is
    // left verbatim (line included) so an out-of-sync template degrades
    // visibly instead of silently losing text.
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    const templatePath = path.join(tmp, 'tmpl.md')
    fs.writeFileSync(
      templatePath,
      [
        'Run dir: {{runDir}}',
        '{{notAKnownKey}}',
        // Mixed line (not placeholder-only) referencing an unknown key — kept,
        // and the replace callback returns `match` for the missing key.
        'mixed prefix {{alsoUnknown}} suffix',
        'tail line',
      ].join('\n'),
    )
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })
    const build = buildOrchestratorHealPrompt({
      agent: 'claude',
      projectRoot: tmp,
      runDir,
      promptPath: templatePath,
    })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain(`Run dir: ${runDir}`)
    expect(prompt).toContain('tail line')
    // The unknown-key placeholder line is kept, left verbatim.
    expect(prompt).toContain('{{notAKnownKey}}')
    // The mixed line is kept; the unknown placeholder is left verbatim.
    expect(prompt).toContain('mixed prefix {{alsoUnknown}} suffix')
  })

  it('failure-artifact scans return false when failedDir exists but is not a directory', () => {
    // failedDir exists (existsSync true) but readdirSync throws ENOTDIR — the
    // `catch { return false }` arms in hasAnyFailureWith /
    // hasAnyFailureWithNonEmptyDir / hasAnyFailureLog are exercised.
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    // buildRunPaths derives failedDir = <runDir>/failed; make it a FILE.
    fs.writeFileSync(path.join(runDir, 'failed'), 'i am a file, not a dir')
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })

    const map = buildHealPromptMap({ projectRoot: tmp, runDir })
    const ids = map.resources.map((r) => r.id)
    expect(ids).not.toContain('failed-slices')
    expect(ids).not.toContain('trace-extract')
    expect(ids).not.toContain('playwright-mcp')
  })

  it('hasAnyFailureLog skips a failure dir whose contents cannot be read (inner catch)', () => {
    // A failure dir entry that is itself unreadable (chmod 000) makes the
    // inner readdirSync throw EACCES — the `catch { continue }` arm runs and
    // the scan moves on, finding the readable sibling's .log.
    const runDir = path.join(tmp, 'run')
    const failedDir = path.join(runDir, 'failed')
    fs.mkdirSync(failedDir, { recursive: true })
    const blocked = path.join(failedDir, '0-blocked')
    fs.mkdirSync(blocked, { recursive: true })
    fs.writeFileSync(path.join(blocked, 'x.log'), 'log')
    const readable = path.join(failedDir, 'z-readable')
    fs.mkdirSync(readable, { recursive: true })
    fs.writeFileSync(path.join(readable, 'y.log'), 'log')
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })
    fs.chmodSync(blocked, 0o000)
    try {
      const map = buildHealPromptMap({ projectRoot: tmp, runDir })
      expect(map.resources.map((r) => r.id)).toContain('failed-slices')
    } finally {
      fs.chmodSync(blocked, 0o755)
    }
  })

  it('hasAnyServiceLog returns false when the run dir cannot be read', () => {
    // runDir exists but is unreadable — readdirSync throws and the
    // `catch { return false }` in hasAnyServiceLog is exercised.
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })
    fs.chmodSync(runDir, 0o000)
    try {
      const map = buildHealPromptMap({ projectRoot: tmp, runDir })
      expect(map.resources.map((r) => r.id)).not.toContain('full-service-log')
    } finally {
      fs.chmodSync(runDir, 0o755)
    }
  })

  it('detectHealMode (via prompt) treats a manifest without repoPaths as test mode', () => {
    // manifest present but repoPaths absent → Array.isArray(undefined) is
    // false → `: []` branch → length 0 → test mode.
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    writeRunManifest(runDir, {})
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot: tmp, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('This feature has no editable service repos')
  })
})
