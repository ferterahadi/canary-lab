import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  checkoutBranch,
  collectRepoBranchSnapshots,
  findRepo,
  getGitStatus,
  parsePorcelainStatus,
  parseRefList,
  resolveRepoPath,
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
})
