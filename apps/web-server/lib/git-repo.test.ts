import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  checkoutBranch,
  collectRepoBranchSnapshots,
  diffNamesSinceSnapshot,
  findRepo,
  getGitStatus,
  parsePorcelainStatus,
  parseRefList,
  resolveRepoPath,
  snapshotWorkingTree,
  validateConfiguredRepoBranches,
} from './git-repo'

function tmpRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-git-')))
  const git = (args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  git(['add', 'README.md'])
  git(['commit', '-m', 'init'])
  git(['checkout', '-b', 'feature/demo'])
  git(['checkout', 'main'])
  return dir
}

describe('git-repo helpers', () => {
  it('resolves home-relative repo paths', () => {
    expect(resolveRepoPath('~')).toBe(os.homedir())
    expect(resolveRepoPath('~/repo')).toBe(path.join(os.homedir(), 'repo'))
    expect(resolveRepoPath('/tmp/repo')).toBe('/tmp/repo')
  })

  it('parses porcelain status and ref lists', () => {
    expect(parsePorcelainStatus(' M README.md\n?? tmp.txt\n\n')).toEqual([' M README.md', '?? tmp.txt'])
    expect(parseRefList('main\nfeature/demo\n\n')).toEqual(['main', 'feature/demo'])
  })

  it('reports empty status for missing, file, and non-git paths', async () => {
    const missing = path.join(os.tmpdir(), 'cl-missing-repo-path')
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-file-')), 'not-dir')
    fs.writeFileSync(file, 'x')
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-plain-'))

    expect(await getGitStatus(missing)).toMatchObject({ isGitRepo: false })
    expect(await getGitStatus(file)).toMatchObject({ isGitRepo: false })
    expect(await getGitStatus(plainDir)).toMatchObject({ isGitRepo: false })
  })

  it('reports clean git status with branches', async () => {
    const repo = tmpRepo()
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/repo.git'], { cwd: repo })
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo })
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: repo })
    const status = await getGitStatus(repo)
    expect(status.isGitRepo).toBe(true)
    expect(status.currentBranch).toBe('main')
    expect(status.dirty).toBe(false)
    expect(status.localBranches).toContain('feature/demo')
    expect(status.remoteBranches).toContain('origin/main')
  })

  it('reports detached git status', async () => {
    const repo = tmpRepo()
    execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: repo, stdio: 'ignore' })
    const status = await getGitStatus(repo)
    expect(status.currentBranch).toBeNull()
    expect(status.detached).toBe(true)
  })

  it('refuses checkout when worktree is dirty', async () => {
    const repo = tmpRepo()
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n')
    await expect(checkoutBranch(repo, 'feature/demo')).rejects.toThrow('repo has uncommitted changes')
  })

  it.each(['', '-bad', 'bad\nname', 'bad\rname', 'bad\0name'])(
    'refuses unsafe checkout branch name %j',
    async (branch) => {
      const repo = tmpRepo()
      await expect(checkoutBranch(repo, branch)).rejects.toMatchObject({ statusCode: 400 })
    },
  )

  it('refuses checkout for non-git paths', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-plain-'))
    await expect(checkoutBranch(plainDir, 'main')).rejects.toThrow('path is not a git repository')
  })

  it('returns current status when checking out the current branch', async () => {
    const repo = tmpRepo()
    const status = await checkoutBranch(repo, 'main')
    expect(status.currentBranch).toBe('main')
  })

  it('surfaces git checkout failures', async () => {
    const repo = tmpRepo()
    await expect(checkoutBranch(repo, 'missing-branch')).rejects.toThrow(/missing-branch|pathspec/)
  })

  it('checks out a clean repo branch', async () => {
    const repo = tmpRepo()
    const status = await checkoutBranch(repo, 'feature/demo')
    expect(status.currentBranch).toBe('feature/demo')
  })

  it('validates configured branch targets before run start', async () => {
    const repo = tmpRepo()
    await expect(validateConfiguredRepoBranches({
      name: 'demo',
      description: 'd',
      envs: [],
      featureDir: repo,
      repos: [{ name: 'app', localPath: repo, branch: 'feature/demo' }],
    })).rejects.toThrow('expected feature/demo, current main')
  })

  it('collects branch snapshots for valid configured repos only', async () => {
    const repo = tmpRepo()
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-plain-'))

    await expect(collectRepoBranchSnapshots({
      name: 'demo',
      description: 'd',
      envs: [],
      featureDir: repo,
      repos: [
        { name: 'app', localPath: repo, branch: 'main' },
        { name: 'plain', localPath: plainDir, branch: 'main' },
        { name: 'bad-local-path', localPath: 123 as unknown as string, branch: 'main' },
      ],
    })).resolves.toEqual([
      {
        name: 'app',
        path: repo,
        branch: 'main',
        expectedBranch: 'main',
        detached: false,
        dirty: false,
      },
    ])
  })

  it('validates happy path and skips repos without branch or string localPath', async () => {
    const repo = tmpRepo()
    await expect(validateConfiguredRepoBranches({
      name: 'empty',
      description: 'd',
      envs: [],
      featureDir: repo,
    })).resolves.toBeUndefined()

    await expect(validateConfiguredRepoBranches({
      name: 'demo',
      description: 'd',
      envs: [],
      featureDir: repo,
      repos: [
        { name: 'app', localPath: repo, branch: 'main' },
        { name: 'skip-no-branch', localPath: repo },
        { name: 'skip-bad-path', localPath: 123 as unknown as string, branch: 'main' },
      ],
    })).resolves.toBeUndefined()
  })

  it('reports non-git and detached configured repo failures', async () => {
    const repo = tmpRepo()
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-plain-'))
    execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: repo, stdio: 'ignore' })

    await expect(validateConfiguredRepoBranches({
      name: 'demo',
      description: 'd',
      envs: [],
      featureDir: repo,
      repos: [
        { name: 'plain', localPath: plainDir, branch: 'main' },
        { name: 'detached', localPath: repo, branch: 'main' },
      ],
    })).rejects.toThrow(/plain: .* is not a git repository[\s\S]*detached: expected main, but checkout is detached/)
  })

  it('finds repos by configured name', () => {
    const feature = {
      name: 'demo',
      description: 'd',
      envs: [],
      featureDir: '/tmp/demo',
      repos: [{ name: 'app', localPath: '/tmp/app' }],
    }
    expect(findRepo(feature, 'app')).toEqual({ name: 'app', localPath: '/tmp/app' })
    expect(findRepo(feature, 'missing')).toBeNull()
    expect(findRepo({ ...feature, repos: undefined }, 'app')).toBeNull()
  })

  describe('snapshotWorkingTree + diffNamesSinceSnapshot', () => {
    it('returns null for non-git and missing paths', async () => {
      const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-plain-snap-'))
      expect(await snapshotWorkingTree(plainDir)).toBeNull()
      expect(await snapshotWorkingTree(path.join(os.tmpdir(), 'cl-missing-snap-xyz'))).toBeNull()
    })

    it('returns HEAD for a clean working tree (stash create produces no SHA)', async () => {
      const repo = tmpRepo()
      expect(await snapshotWorkingTree(repo)).toBe('HEAD')
    })

    it('returns a non-empty SHA for a dirty working tree', async () => {
      const repo = tmpRepo()
      fs.writeFileSync(path.join(repo, 'README.md'), 'edited\n')
      const ref = await snapshotWorkingTree(repo)
      expect(ref).not.toBeNull()
      expect(ref).not.toBe('HEAD')
      // git stash create prints a hex commit SHA (≥ 7 chars, typically 40).
      expect(ref).toMatch(/^[0-9a-f]{7,}$/)
    })

    it('diffs only what changed between snapshot and now (clean baseline)', async () => {
      const repo = tmpRepo()
      const ref = await snapshotWorkingTree(repo)
      expect(ref).toBe('HEAD')
      fs.writeFileSync(path.join(repo, 'README.md'), 'after\n')
      const changed = await diffNamesSinceSnapshot(repo, ref!)
      expect(changed).toEqual(['README.md'])
    })

    it('isolates the agent edit window from pre-existing dirty state', async () => {
      // Pre-existing dirty file on a tracked path (the user's WIP before heal
      // started). The runner should NOT log this as an agent-edited file.
      const repo = tmpRepo()
      execFileSync('git', ['checkout', '-b', 'work'], { cwd: repo, stdio: 'ignore' })
      // Commit a second tracked file so we have two tracked targets.
      fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 1\n')
      execFileSync('git', ['add', 'app.ts'], { cwd: repo })
      execFileSync('git', ['commit', '-m', 'add app'], { cwd: repo, stdio: 'ignore' })
      // Dirty README BEFORE the snapshot — this is pre-existing state.
      fs.writeFileSync(path.join(repo, 'README.md'), 'pre-existing dirty\n')

      const ref = await snapshotWorkingTree(repo)
      expect(ref).not.toBeNull()
      expect(ref).not.toBe('HEAD')

      // "Agent" turn: only edits app.ts.
      fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 2\n')

      const changed = await diffNamesSinceSnapshot(repo, ref!)
      expect(changed).toEqual(['app.ts'])
      expect(changed).not.toContain('README.md')
    })

    it('returns an empty array when nothing changed during the agent turn', async () => {
      const repo = tmpRepo()
      const ref = await snapshotWorkingTree(repo)
      expect(await diffNamesSinceSnapshot(repo, ref!)).toEqual([])
    })

    it('omits untracked files (no -u on stash create)', async () => {
      const repo = tmpRepo()
      const ref = await snapshotWorkingTree(repo)
      // Untracked file created during the "agent" turn.
      fs.writeFileSync(path.join(repo, 'scratch.tmp'), 'build artifact\n')
      const changed = await diffNamesSinceSnapshot(repo, ref!)
      expect(changed).not.toContain('scratch.tmp')
    })

    it('diffNamesSinceSnapshot returns [] on a non-git path', async () => {
      const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-plain-diff-'))
      expect(await diffNamesSinceSnapshot(plainDir, 'HEAD')).toEqual([])
    })
  })
})
