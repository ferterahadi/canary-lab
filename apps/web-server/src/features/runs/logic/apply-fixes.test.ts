import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyFixCapture } from './apply-fixes'
import type { RunFixCapture } from '../../../../../../shared/run-state'

let root: string
let repo: string
let fixesDir: string

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-fix-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path.join(repo, 'app.js'), 'const x = 1\n')
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 't@t'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init', '--no-verify'])
  fixesDir = path.join(root, 'fixes')
  fs.mkdirSync(fixesDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Build a real patch that turns app.js `x = 1` → `x = 2`, from a scratch clone. */
function makePatch(): string {
  const scratch = path.join(root, 'scratch')
  execFileSync('git', ['clone', '-q', repo, scratch], { stdio: 'ignore' })
  fs.writeFileSync(path.join(scratch, 'app.js'), 'const x = 2\n')
  const diff = execFileSync('git', ['diff'], { cwd: scratch }).toString()
  const patchPath = path.join(fixesDir, 'repo.patch')
  fs.writeFileSync(patchPath, diff)
  return patchPath
}

function capture(patchPath: string): RunFixCapture {
  return {
    capturedAt: '2026-07-24T00:00:00.000Z',
    repos: [{ repoName: 'repo', patchPath, patchFile: 'repo.patch', repoRoot: repo, baseSha: 'deadbeef', files: 1 }],
  }
}

describe('applyFixCapture', () => {
  it('applies the patch into the real repo working tree', async () => {
    const out = await applyFixCapture(capture(makePatch()))
    expect(out.allOk).toBe(true)
    expect(out.results).toEqual([{ repoName: 'repo', ok: true }])
    expect(fs.readFileSync(path.join(repo, 'app.js'), 'utf-8')).toBe('const x = 2\n')
  })

  it('reports a missing patch file per repo without throwing', async () => {
    const out = await applyFixCapture(capture(path.join(fixesDir, 'gone.patch')))
    expect(out.allOk).toBe(false)
    expect(out.results[0]).toMatchObject({ repoName: 'repo', ok: false })
    expect(out.results[0].reason).toMatch(/missing/i)
  })

  it('reports a repo whose path no longer exists, naming the path', async () => {
    const patchPath = makePatch()
    const gone = path.join(root, 'moved-away')
    const out = await applyFixCapture({
      capturedAt: 'now',
      repos: [{ repoName: 'repo', patchPath, patchFile: 'repo.patch', repoRoot: gone, baseSha: 'deadbeef', files: 1 }],
    })
    expect(out.allOk).toBe(false)
    expect(out.results[0]).toEqual({ repoName: 'repo', ok: false, reason: `repo path no longer exists: ${gone}` })
  })

  it('falls back to a generic reason when git apply fails silently', async () => {
    // An empty patch against a non-repo directory: `git apply` exits non-zero
    // with nothing on either stream, so the reason has to come from us.
    const plainDir = path.join(root, 'not-a-repo')
    fs.mkdirSync(plainDir, { recursive: true })
    const patchPath = path.join(fixesDir, 'empty.patch')
    fs.writeFileSync(patchPath, '')

    const out = await applyFixCapture({
      capturedAt: 'now',
      repos: [{ repoName: 'repo', patchPath, patchFile: 'empty.patch', repoRoot: plainDir, baseSha: 'deadbeef', files: 0 }],
    })

    expect(out.allOk).toBe(false)
    expect(out.results[0].ok).toBe(false)
    expect(out.results[0].reason).toBeTruthy()
  })

  it('reports a per-repo failure when the patch no longer applies', async () => {
    const patchPath = makePatch()
    // Move the repo out from under the patch so it cannot apply.
    fs.writeFileSync(path.join(repo, 'app.js'), 'completely different\n')
    git(repo, ['commit', '-aqm', 'drift', '--no-verify'])
    const out = await applyFixCapture(capture(patchPath))
    expect(out.allOk).toBe(false)
    expect(out.results[0].ok).toBe(false)
    expect(out.results[0].reason).toBeTruthy()
  })
})
