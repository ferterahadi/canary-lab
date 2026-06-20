import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit, diffContentSinceSnapshot } from '../../../../shared/git-repo'
import { applyOverlay, reverseOverlay } from './git-ops'

const roots: string[] = []
afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

const BASE = [
  'const config = {}',
  "const host = 'localhost'",
  'const PORT = 3007',
  'const timeout = 5000',
  'module.exports = { PORT }',
  '',
].join('\n')

const PORTED = BASE.replace('const PORT = 3007', 'const PORT = Number(process.env.PORT)')

async function tmpRepo(body: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-overlay-apply-'))
  roots.push(root)
  fs.writeFileSync(path.join(root, 'app.js'), body)
  await runGit(root, ['init', '-q'])
  await runGit(root, ['config', 'user.email', 't@t'])
  await runGit(root, ['config', 'user.name', 'test'])
  await runGit(root, ['add', '-A'])
  await runGit(root, ['commit', '-q', '-m', 'init', '--no-verify'])
  return root
}

/** Capture a unified diff (with `index` lines) for an edit, then revert it. */
async function capturePatch(repo: string, edited: string): Promise<string> {
  const file = path.join(repo, 'app.js')
  const original = fs.readFileSync(file, 'utf-8')
  fs.writeFileSync(file, edited)
  const diff = await diffContentSinceSnapshot(repo, 'HEAD')
  fs.writeFileSync(file, original)
  return diff
}

function writePatch(repo: string, content: string): string {
  const p = path.join(repo, 'overlay.patch')
  fs.writeFileSync(p, content)
  return p
}

const read = (repo: string) => fs.readFileSync(path.join(repo, 'app.js'), 'utf-8')

describe('applyOverlay', () => {
  it('applies a clean patch into the worktree', async () => {
    const repo = await tmpRepo(BASE)
    const patch = writePatch(repo, await capturePatch(repo, PORTED))

    const out = await applyOverlay(repo, patch)
    expect(out.kind).toBe('ok')
    expect(read(repo)).toContain('Number(process.env.PORT)')
  })

  it('falls back to --3way when a context line drifted', async () => {
    const repo = await tmpRepo(BASE)
    const patch = writePatch(repo, await capturePatch(repo, PORTED))

    // The user edits a CONTEXT line (within the hunk) and commits — strict apply
    // would fail on the mismatched context, but --3way reconstructs via the blob.
    fs.writeFileSync(path.join(repo, 'app.js'), BASE.replace('const config = {}', 'const config = { debug: true }'))
    await runGit(repo, ['commit', '-aqm', 'drift', '--no-verify'])

    const out = await applyOverlay(repo, patch)
    expect(out.kind).toBe('ok')
    const after = read(repo)
    expect(after).toContain('Number(process.env.PORT)') // the port edit landed
    expect(after).toContain('{ debug: true }')          // the user's edit preserved
  })

  it('returns error when the base blob is unavailable (unrelated repo)', async () => {
    const src = await tmpRepo(BASE)
    const patch = await capturePatch(src, PORTED)

    // Apply into a different repo with no shared history → no base blob → hard error.
    const other = await tmpRepo('const PORT = 9999\nmodule.exports = {}\n')
    const patchPath = writePatch(other, patch)
    const out = await applyOverlay(other, patchPath)
    expect(out.kind).toBe('error')
    if (out.kind === 'error') expect(out.detail).toMatch(/does not apply|blob/i)
  })

  it('is a no-op ok for a blank patch', async () => {
    const repo = await tmpRepo(BASE)
    const patch = writePatch(repo, '\n  \n')
    const out = await applyOverlay(repo, patch)
    expect(out.kind).toBe('ok')
    expect(read(repo)).toBe(BASE)
  })

  it('returns error when the patch path does not exist (exercises isBlankPatch catch)', async () => {
    const repo = await tmpRepo(BASE)
    const out = await applyOverlay(repo, path.join(repo, 'nonexistent.patch'))
    expect(out.kind).toBe('error')
  })

  it('reports conflict when --3way hits a genuine merge conflict on the same line', async () => {
    const repo = await tmpRepo(BASE)
    const patch = writePatch(repo, await capturePatch(repo, PORTED))

    // Change the TARGET line (same line the patch modifies) so --3way cannot
    // auto-merge — both patch and current HEAD modified the same hunk.
    const conflicting = BASE.replace('const PORT = 3007', 'const PORT = 9000 // user change')
    fs.writeFileSync(path.join(repo, 'app.js'), conflicting)
    await runGit(repo, ['commit', '-aqm', 'conflict-change', '--no-verify'])

    const out = await applyOverlay(repo, patch)
    expect(out.kind).toBe('conflict')
    if (out.kind === 'conflict') expect(out.files).toContain('app.js')
  })
})

describe('reverseOverlay', () => {
  it('reverses a cleanly-applied patch back to base', async () => {
    const repo = await tmpRepo(BASE)
    const patch = writePatch(repo, await capturePatch(repo, PORTED))

    expect((await applyOverlay(repo, patch)).kind).toBe('ok')
    expect(read(repo)).toContain('process.env.PORT')

    const out = await reverseOverlay(repo, patch)
    expect(out.kind).toBe('ok')
    expect(read(repo)).toBe(BASE)
  })

  it('surfaces a conflict and leaves the file intact when a heal edit overlaps', async () => {
    const repo = await tmpRepo(BASE)
    const patch = writePatch(repo, await capturePatch(repo, PORTED))

    expect((await applyOverlay(repo, patch)).kind).toBe('ok')

    // Simulate the heal agent editing the SAME line the overlay touched.
    const healed = PORTED.replace(
      'const PORT = Number(process.env.PORT)',
      'const PORT = Number(process.env.PORT) || 3007',
    )
    fs.writeFileSync(path.join(repo, 'app.js'), healed)

    const out = await reverseOverlay(repo, patch)
    expect(out.kind).toBe('conflict')
    if (out.kind === 'conflict') expect(out.files).toContain('app.js')
    // File is left untouched — the heal edit survives.
    expect(read(repo)).toBe(healed)
  })

  it('is a no-op ok for a blank patch', async () => {
    const repo = await tmpRepo(BASE)
    const patch = writePatch(repo, '   ')
    const out = await reverseOverlay(repo, patch)
    expect(out.kind).toBe('ok')
  })

  it('returns conflict with empty files when the patch path does not exist (exercises patchFiles code-nonzero)', async () => {
    const repo = await tmpRepo(BASE)
    const out = await reverseOverlay(repo, path.join(repo, 'nonexistent.patch'))
    expect(out.kind).toBe('conflict')
    if (out.kind === 'conflict') expect(out.files).toEqual([])
  })
})
