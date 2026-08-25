import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  applyExternalDraftFiles,
  captureFeatureEnvFiles,
  checkoutFeatureRepoBranch,
  createFeatureSkeleton,
  deleteFeature,
  deleteFeatureDoc,
  envsetSchema,
  externalTestFileRules,
  getFeatureEnvsetSummary,
  getFeatureRepoStatus,
  linkFeatureDoc,
  parseRedactedEntries,
  writeFeatureDoc,
} from './feature-authoring'

let tmpDir: string

let featuresDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-feature-authoring-')))
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function ctx() {
  return { projectRoot: tmpDir, featuresDir }
}

function writeFeatureConfig(
  feature: string,
  extras: string = '',
  repos: string = '[]',
): string {
  const featureDir = path.join(featuresDir, feature)
  fs.mkdirSync(featureDir, { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `const config = {
  name: '${feature}',
  envs: ['local'],
  repos: ${repos},
  featureDir: __dirname,
  ${extras}
}
module.exports = { config }
`, 'utf8')
  return featureDir
}

describe('writeFeatureDoc', () => {
  it('writes a markdown doc into the feature docs/ dir and reports the relative path', () => {
    const featureDir = writeFeatureConfig('line_integration')
    const res = writeFeatureDoc(ctx(), {
      feature: 'line_integration',
      relPath: 'session-notes.md',
      content: '# Notes\n\nDistilled.',
    })
    expect(res).toEqual({
      ok: true,
      writtenPath: path.join(featureDir, 'docs', 'session-notes.md'),
      relativePath: path.join('docs', 'session-notes.md'),
    })
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'session-notes.md'), 'utf8')).toBe('# Notes\n\nDistilled.')
  })

  it('is create-or-replace — re-writing the same relPath overwrites', () => {
    writeFeatureConfig('line_integration')
    writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'plan.md', content: 'v1' })
    const res = writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'plan.md', content: 'v2' })
    expect(res.ok).toBe(true)
    const featureDir = path.join(featuresDir, 'line_integration')
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'plan.md'), 'utf8')).toBe('v2')
  })

  it('strips an optional leading docs/ so both forms land in docs/', () => {
    writeFeatureConfig('line_integration')
    const res = writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'docs/plan.md', content: 'x' })
    expect(res).toMatchObject({ ok: true, relativePath: path.join('docs', 'plan.md') })
  })

  it('supports nested subdirectories under docs/', () => {
    const featureDir = writeFeatureConfig('line_integration')
    const res = writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'sessions/2026-05-28.md', content: 'x' })
    expect(res).toMatchObject({ ok: true, relativePath: path.join('docs', 'sessions', '2026-05-28.md') })
    expect(fs.existsSync(path.join(featureDir, 'docs', 'sessions', '2026-05-28.md'))).toBe(true)
  })

  it('rejects an unknown feature', () => {
    expect(writeFeatureDoc(ctx(), { feature: 'nope', relPath: 'x.md', content: 'x' }))
      .toEqual({ ok: false, error: 'feature not found' })
  })

  it('rejects empty content', () => {
    writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'x.md', content: '   ' }))
      .toEqual({ ok: false, error: 'content must be a non-empty string' })
  })

  it('rejects an absolute relPath', () => {
    writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: '/etc/passwd.md', content: 'x' }))
      .toEqual({ ok: false, error: 'relPath must be relative' })
  })

  it('rejects a non-markdown extension', () => {
    writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'notes.txt', content: 'x' }))
      .toEqual({ ok: false, error: 'relPath must end in .md or .markdown' })
  })

  it('rejects an empty relPath', () => {
    writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: null as never, content: 'x' }))
      .toEqual({ ok: false, error: 'relPath required' })
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: '   ', content: 'x' }))
      .toEqual({ ok: false, error: 'relPath required' })
  })

  it('rejects a path that escapes the docs directory', () => {
    const featureDir = writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: '../escape.md', content: 'x' }))
      .toEqual({ ok: false, error: 'relPath must not escape the docs directory' })
    expect(fs.existsSync(path.join(featureDir, 'escape.md'))).toBe(false)
  })
})

describe('deleteFeatureDoc', () => {
  it('deletes an existing doc and reports its relative path', () => {
    const featureDir = writeFeatureConfig('del_test')
    const docsDir = path.join(featureDir, 'docs')
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(path.join(docsDir, 'notes.md'), 'content')
    const res = deleteFeatureDoc(ctx(), { feature: 'del_test', relPath: 'notes.md' })
    expect(res).toEqual({ ok: true, relativePath: path.join('docs', 'notes.md') })
    expect(fs.existsSync(path.join(docsDir, 'notes.md'))).toBe(false)
  })

  it('returns feature-not-found when the feature does not exist (line 311)', () => {
    expect(deleteFeatureDoc(ctx(), { feature: 'no-such-feature', relPath: 'notes.md' }))
      .toEqual({ ok: false, error: 'feature not found' })
  })

  it('rejects an invalid relPath via resolveDocRelPath (line 313)', () => {
    writeFeatureConfig('del_test2')
    // Absolute paths fail resolveDocRelPath → resolved.ok === false
    const res = deleteFeatureDoc(ctx(), { feature: 'del_test2', relPath: '/etc/passwd.md' })
    expect(res).toMatchObject({ ok: false })
  })

  it('refuses to delete a _-prefixed generated artifact (line 314-316)', () => {
    const featureDir = writeFeatureConfig('del_test3')
    const docsDir = path.join(featureDir, 'docs')
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(path.join(docsDir, '_prd-summary.md'), 'generated')
    expect(deleteFeatureDoc(ctx(), { feature: 'del_test3', relPath: '_prd-summary.md' }))
      .toEqual({ ok: false, error: 'cannot delete a generated artifact' })
  })

  it('rejects a path-traversal attempt (line 319)', () => {
    writeFeatureConfig('del_test4')
    expect(deleteFeatureDoc(ctx(), { feature: 'del_test4', relPath: '../escape.md' }))
      .toEqual({ ok: false, error: 'relPath must not escape the docs directory' })
  })

  it('returns doc-not-found when the file does not exist (line 320)', () => {
    writeFeatureConfig('del_test5')
    expect(deleteFeatureDoc(ctx(), { feature: 'del_test5', relPath: 'missing.md' }))
      .toEqual({ ok: false, error: 'doc not found' })
  })
})

describe('linkFeatureDoc', () => {
  it('symlinks a local doc into docs/ and reports linked: true', () => {
    const featureDir = writeFeatureConfig('link_test')
    const target = path.join(tmpDir, 'external-prd.md')
    fs.writeFileSync(target, '# External PRD')
    const res = linkFeatureDoc(ctx(), { feature: 'link_test', targetPath: target })
    expect(res).toMatchObject({ ok: true, linked: true, relativePath: path.join('docs', 'external-prd.md') })
    const dest = path.join(featureDir, 'docs', 'external-prd.md')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('# External PRD')
  })

  it('the user original stays the live source — edits show through the link', () => {
    const featureDir = writeFeatureConfig('link_live')
    const target = path.join(tmpDir, 'live.md')
    fs.writeFileSync(target, 'v1')
    linkFeatureDoc(ctx(), { feature: 'link_live', targetPath: target })
    fs.writeFileSync(target, 'v2')
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'live.md'), 'utf8')).toBe('v2')
  })

  it('accepts a plain-text target (links keep their original name)', () => {
    writeFeatureConfig('link_txt')
    const target = path.join(tmpDir, 'notes.txt')
    fs.writeFileSync(target, 'plain notes')
    expect(linkFeatureDoc(ctx(), { feature: 'link_txt', targetPath: target })).toMatchObject({ ok: true })
  })

  it('expands a ~-relative target path', () => {
    writeFeatureConfig('link_home')
    // Use a real file under the home dir via a relative spelling.
    const home = os.homedir()
    const target = path.join(home, `.cl-link-test-${process.pid}.md`)
    fs.writeFileSync(target, 'home doc')
    try {
      const res = linkFeatureDoc(ctx(), { feature: 'link_home', targetPath: `~/${path.basename(target)}` })
      expect(res).toMatchObject({ ok: true })
    } finally {
      fs.rmSync(target, { force: true })
    }
  })

  it('rejects a missing target, a directory, and a disallowed extension', () => {
    writeFeatureConfig('link_rejects')
    expect(linkFeatureDoc(ctx(), { feature: 'link_rejects', targetPath: path.join(tmpDir, 'nope.md') }))
      .toMatchObject({ ok: false, error: expect.stringContaining('does not exist') })
    expect(linkFeatureDoc(ctx(), { feature: 'link_rejects', targetPath: tmpDir }))
      .toMatchObject({ ok: false, error: 'target is not a file' })
    const bin = path.join(tmpDir, 'app.bin')
    fs.writeFileSync(bin, 'x')
    expect(linkFeatureDoc(ctx(), { feature: 'link_rejects', targetPath: bin }))
      .toMatchObject({ ok: false, error: expect.stringContaining('can be linked') })
  })

  it('replaces an existing doc of the same name', () => {
    const featureDir = writeFeatureConfig('link_replace')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', 'prd.md'), 'old copy')
    const target = path.join(tmpDir, 'prd.md')
    fs.writeFileSync(target, 'linked now')
    const res = linkFeatureDoc(ctx(), { feature: 'link_replace', targetPath: target })
    expect(res).toMatchObject({ ok: true, linked: true })
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'prd.md'), 'utf8')).toBe('linked now')
  })

  it('rejects an explicit relPath with a disallowed extension (allowTxt error branch)', () => {
    writeFeatureConfig('link_bad_relpath')
    const target = path.join(tmpDir, 'external.md')
    fs.writeFileSync(target, '# External')
    const res = linkFeatureDoc(ctx(), { feature: 'link_bad_relpath', targetPath: target, relPath: 'notes.bin' })
    expect(res).toEqual({ ok: false, error: 'relPath must end in .md, .markdown or .txt' })
  })

  it('rejects an explicit relPath that escapes the docs directory', () => {
    const featureDir = writeFeatureConfig('link_escape')
    const target = path.join(tmpDir, 'external.md')
    fs.writeFileSync(target, '# External')
    const res = linkFeatureDoc(ctx(), { feature: 'link_escape', targetPath: target, relPath: '../escape.md' })
    expect(res).toEqual({ ok: false, error: 'relPath must not escape the docs directory' })
    expect(fs.existsSync(path.join(featureDir, 'escape.md'))).toBe(false)
  })

  it('rejects linking a target that already lives inside the docs directory', () => {
    const featureDir = writeFeatureConfig('link_self')
    const docsDir = path.join(featureDir, 'docs')
    fs.mkdirSync(docsDir, { recursive: true })
    const alreadyInDocs = path.join(docsDir, 'existing.md')
    fs.writeFileSync(alreadyInDocs, '# Already here')
    const res = linkFeatureDoc(ctx(), { feature: 'link_self', targetPath: alreadyInDocs })
    expect(res).toEqual({ ok: false, error: 'target is already inside the docs directory' })
  })

  it('falls back to copying when symlinkSync fails (e.g. no symlink permission) and reports linked: false', () => {
    const featureDir = writeFeatureConfig('link_no_symlink')
    const target = path.join(tmpDir, 'external-copy.md')
    fs.writeFileSync(target, '# Copied content')
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted, symlink')
    })
    const res = linkFeatureDoc(ctx(), { feature: 'link_no_symlink', targetPath: target })
    expect(res).toMatchObject({ ok: true, linked: false })
    const dest = path.join(featureDir, 'docs', 'external-copy.md')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('# Copied content')
  })
})

describe('symlink-aware doc write/delete', () => {
  it('writeFeatureDoc onto a symlink replaces the link — never writes through into the target', () => {
    const featureDir = writeFeatureConfig('link_write_guard')
    const target = path.join(tmpDir, 'original.md')
    fs.writeFileSync(target, 'original content')
    linkFeatureDoc(ctx(), { feature: 'link_write_guard', targetPath: target })
    const res = writeFeatureDoc(ctx(), { feature: 'link_write_guard', relPath: 'original.md', content: 'replaced in docs' })
    expect(res).toMatchObject({ ok: true })
    const dest = path.join(featureDir, 'docs', 'original.md')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('replaced in docs')
    // The user's original is untouched.
    expect(fs.readFileSync(target, 'utf8')).toBe('original content')
  })

  it('deleteFeatureDoc removes the link only — the target survives', () => {
    const featureDir = writeFeatureConfig('link_delete')
    const target = path.join(tmpDir, 'survives.md')
    fs.writeFileSync(target, 'keep me')
    linkFeatureDoc(ctx(), { feature: 'link_delete', targetPath: target })
    const res = deleteFeatureDoc(ctx(), { feature: 'link_delete', relPath: 'survives.md' })
    expect(res).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(featureDir, 'docs', 'survives.md'))).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me')
  })

  it('deleteFeatureDoc removes a DANGLING symlink (target already moved)', () => {
    const featureDir = writeFeatureConfig('link_dangling')
    const target = path.join(tmpDir, 'moves-away.md')
    fs.writeFileSync(target, 'soon gone')
    linkFeatureDoc(ctx(), { feature: 'link_dangling', targetPath: target })
    fs.rmSync(target)
    const res = deleteFeatureDoc(ctx(), { feature: 'link_dangling', relPath: 'moves-away.md' })
    expect(res).toMatchObject({ ok: true })
    expect(fs.lstatSync(path.join(featureDir, 'docs'), { throwIfNoEntry: false })).toBeTruthy()
  })
})
