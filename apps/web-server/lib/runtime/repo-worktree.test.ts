import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addWorktree, isGitWorktreeCapable, removeWorktree } from './repo-worktree'

let root: string
let repo: string

function gitInit(dir: string): void {
  const opts = { cwd: dir, stdio: 'ignore' as const }
  execFileSync('git', ['init', '-q'], opts)
  execFileSync('git', ['config', 'user.email', 'test@example.com'], opts)
  execFileSync('git', ['config', 'user.name', 'Test'], opts)
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], opts)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'))
  repo = path.join(root, 'app')
  fs.mkdirSync(path.join(repo, 'features', 'foo'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'features', 'foo', 'server.ts'), 'export const x = 1\n')
  gitInit(repo)
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'add files'], { cwd: repo, stdio: 'ignore' })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('isGitWorktreeCapable', () => {
  it('is true inside a git repo and false outside', async () => {
    expect(await isGitWorktreeCapable(repo)).toBe(true)
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    expect(await isGitWorktreeCapable(plain)).toBe(false)
  })
})

describe('addWorktree / removeWorktree', () => {
  it('creates an isolated worktree and remaps a subdirectory localPath', async () => {
    const subdir = path.join(repo, 'features', 'foo')
    const worktreesDir = path.join(root, 'run-1', 'worktrees')
    const handle = await addWorktree({ repoName: 'app', localPath: subdir, worktreesDir })

    expect(fs.existsSync(handle.worktreeRoot)).toBe(true)
    expect(handle.worktreeRoot).not.toBe(repo)
    // Subpath preserved into the worktree.
    expect(handle.localPath).toBe(path.join(handle.worktreeRoot, 'features', 'foo'))
    expect(fs.existsSync(path.join(handle.localPath, 'server.ts'))).toBe(true)

    // Editing the worktree copy does not touch the source.
    fs.writeFileSync(path.join(handle.localPath, 'server.ts'), 'export const x = 2\n')
    expect(fs.readFileSync(path.join(subdir, 'server.ts'), 'utf-8')).toBe('export const x = 1\n')

    await removeWorktree(handle)
    expect(fs.existsSync(handle.worktreeRoot)).toBe(false)
  })

  it('throws NOT_A_GIT_REPO for a non-git path', async () => {
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    await expect(
      addWorktree({ repoName: 'plain', localPath: plain, worktreesDir: path.join(root, 'wt') }),
    ).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' })
  })

  it('maps localPath to the worktree root when the repo root itself is the target', async () => {
    const worktreesDir = path.join(root, 'run-root', 'worktrees')
    const handle = await addWorktree({ repoName: 'app', localPath: repo, worktreesDir })
    // No subpath → the run's localPath is the worktree root itself.
    expect(handle.localPath).toBe(handle.worktreeRoot)
    await removeWorktree(handle)
  })

  it('falls back to "repo" when the repo name sanitizes to empty', async () => {
    const handle = await addWorktree({ repoName: '///', localPath: repo, worktreesDir: path.join(root, 'wt-sani') })
    expect(path.basename(handle.worktreeRoot)).toBe('repo')
    await removeWorktree(handle)
  })

  it('throws when git worktree add fails (e.g. unknown branch ref)', async () => {
    await expect(
      addWorktree({ repoName: 'app', localPath: repo, worktreesDir: path.join(root, 'wt-fail'), branch: 'no-such-branch' }),
    ).rejects.toThrow(/git worktree add failed/)
  })

  it('removeWorktree falls back to prune + rm when the worktree is already gone', async () => {
    // A path that was never registered as a worktree → `git worktree remove`
    // fails (code != 0) → prune + best-effort rm. Resolves without throwing.
    await expect(
      removeWorktree({ sourceRoot: repo, worktreeRoot: path.join(root, 'ghost-worktree') }),
    ).resolves.toBeUndefined()
  })
})
