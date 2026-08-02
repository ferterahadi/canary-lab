import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addWorktree, hydrateWorkingTreeDiff, isGitWorktreeCapable, linkNodeModules, listUntracked, removeWorktree, sanitizeRepoFileName } from './repo-worktree'

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

  describe('linkNodeModules', () => {
    it('symlinks the source node_modules into the worktree when absent there', () => {
      const src = path.join(root, 'src-repo')
      const wt = path.join(root, 'wt-repo')
      fs.mkdirSync(path.join(src, 'node_modules', 'pkg'), { recursive: true })
      fs.mkdirSync(wt, { recursive: true })
      linkNodeModules({ sourceRoot: src, worktreeRoot: wt })
      const dst = path.join(wt, 'node_modules')
      expect(fs.existsSync(dst)).toBe(true)
      expect(fs.lstatSync(dst).isSymbolicLink()).toBe(true)
      expect(fs.existsSync(path.join(dst, 'pkg'))).toBe(true)
    })

    it('is a no-op when the source has no node_modules', () => {
      const src = path.join(root, 'src-empty')
      const wt = path.join(root, 'wt-empty')
      fs.mkdirSync(src, { recursive: true })
      fs.mkdirSync(wt, { recursive: true })
      linkNodeModules({ sourceRoot: src, worktreeRoot: wt })
      expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false)
    })

    it('leaves an existing worktree node_modules untouched', () => {
      const src = path.join(root, 'src2')
      const wt = path.join(root, 'wt2')
      fs.mkdirSync(path.join(src, 'node_modules'), { recursive: true })
      fs.mkdirSync(path.join(wt, 'node_modules', 'already'), { recursive: true })
      linkNodeModules({ sourceRoot: src, worktreeRoot: wt })
      // Real dir preserved (not replaced by a symlink).
      expect(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink()).toBe(false)
      expect(fs.existsSync(path.join(wt, 'node_modules', 'already'))).toBe(true)
    })
  })

  describe('hydrateWorkingTreeDiff', () => {
    it('reproduces tracked WIP and untracked files in a fresh worktree', async () => {
      // Dirty the source: edit a tracked file + add an untracked one.
      fs.writeFileSync(path.join(repo, 'features', 'foo', 'server.ts'), 'export const x = 42\n')
      fs.writeFileSync(path.join(repo, 'features', 'foo', 'new.ts'), 'export const y = 2\n')
      const handle = await addWorktree({ repoName: 'app', localPath: repo, worktreesDir: path.join(root, 'wt-hy') })
      // The fresh worktree checks out HEAD only — WIP is absent until hydrated.
      expect(fs.readFileSync(path.join(handle.worktreeRoot, 'features/foo/server.ts'), 'utf-8')).toContain('x = 1')
      expect(fs.existsSync(path.join(handle.worktreeRoot, 'features/foo/new.ts'))).toBe(false)

      const res = await hydrateWorkingTreeDiff(handle)
      expect(res.error).toBeUndefined()
      expect(res.trackedApplied).toBe(true)
      expect(res.untrackedCopied).toBe(1)
      // Now the worktree matches the source's working tree.
      expect(fs.readFileSync(path.join(handle.worktreeRoot, 'features/foo/server.ts'), 'utf-8')).toContain('x = 42')
      expect(fs.readFileSync(path.join(handle.worktreeRoot, 'features/foo/new.ts'), 'utf-8')).toContain('y = 2')
    })

    it('is a clean no-op when the source tree is pristine', async () => {
      const handle = await addWorktree({ repoName: 'app', localPath: repo, worktreesDir: path.join(root, 'wt-clean') })
      const res = await hydrateWorkingTreeDiff(handle)
      expect(res).toEqual({ trackedApplied: false, untrackedCopied: 0, error: undefined })
    })

    it('does not copy gitignored files', async () => {
      fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n')
      execFileSync('git', ['add', '.gitignore'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'ignore'], { cwd: repo, stdio: 'ignore' })
      fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')
      const handle = await addWorktree({ repoName: 'app', localPath: repo, worktreesDir: path.join(root, 'wt-ign') })
      const res = await hydrateWorkingTreeDiff(handle)
      expect(res.untrackedCopied).toBe(0)
      expect(fs.existsSync(path.join(handle.worktreeRoot, '.env'))).toBe(false)
    })
  })
})

describe('sanitizeRepoFileName', () => {
  it('leaves an already-safe name alone', () => {
    expect(sanitizeRepoFileName('my-api_v2.1')).toBe('my-api_v2.1')
  })

  it('collapses path separators and spaces so a name cannot escape the fixes dir', () => {
    expect(sanitizeRepoFileName('org/repo name')).toBe('org-repo-name')
    // Dots are legal in a filename and survive; what matters is that every
    // separator is gone, so the result cannot traverse out of the fixes dir.
    expect(sanitizeRepoFileName('../../etc/passwd')).toBe('..-..-etc-passwd')
    expect(sanitizeRepoFileName('../../etc/passwd')).not.toContain('/')
  })

  it('falls back to "repo" when nothing usable survives', () => {
    expect(sanitizeRepoFileName('///')).toBe('repo')
    expect(sanitizeRepoFileName('')).toBe('repo')
  })
})

describe('listUntracked', () => {
  it('lists non-ignored untracked files and skips ignored ones', async () => {
    const dir = path.join(root, 'untracked-repo')
    fs.mkdirSync(dir, { recursive: true })
    gitInit(dir)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n')
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'x')
    fs.writeFileSync(path.join(dir, 'fresh.txt'), 'x')

    const out = await listUntracked(dir)

    expect(out.has('fresh.txt')).toBe(true)
    expect(out.has('ignored.txt')).toBe(false)
  })

  it('returns an empty set when the path is not a git repo', async () => {
    // The fix-capture baseline runs before we know a repo is usable, so a
    // non-repo must read as "nothing untracked" rather than throw mid-run.
    // Safe only because `git stash create` fails on the same inputs (measured:
    // both exit 128 for a non-work-tree and for a bad core.excludesFile), so
    // the baseline skips such a repo before this empty set can be mistaken for
    // a clean tree — which is what would file pre-existing files as agent-new.
    const dir = path.join(root, 'not-a-repo')
    fs.mkdirSync(dir, { recursive: true })

    expect(await listUntracked(dir)).toEqual(new Set())
  })
})
