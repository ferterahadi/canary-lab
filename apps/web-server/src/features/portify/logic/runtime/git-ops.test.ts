import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../../../../shared/git-repo'
import {
  portifyBranchName,
  createBranchAndWorktree,
  captureDiff,
  changedFiles,
  discardWorktree,
} from './git-ops'

const roots: string[] = []
afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

async function tmpRepo(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-git-'))
  roots.push(root)
  fs.writeFileSync(path.join(root, 'app.js'), 'const PORT = 3007\n')
  await runGit(root, ['init', '-q'])
  await runGit(root, ['config', 'user.email', 't@t'])
  await runGit(root, ['config', 'user.name', 'test'])
  await runGit(root, ['add', '-A'])
  await runGit(root, ['commit', '-q', '-m', 'init', '--no-verify'])
  return root
}

describe('portifyBranchName', () => {
  it('slugifies the feature into a canary/dynamic-ports branch', () => {
    expect(portifyBranchName('cns_batch_queue')).toBe('canary/dynamic-ports-cns-batch-queue')
    expect(portifyBranchName('My Feat!!')).toBe('canary/dynamic-ports-my-feat')
    expect(portifyBranchName('!!!')).toBe('canary/dynamic-ports-feature')
  })
})

describe('git-ops scratch worktree lifecycle', () => {
  it('creates a scratch branch + worktree off HEAD, captures the diff, and discards both', async () => {
    const repo = await tmpRepo()
    const headRev = await runGit(repo, ['rev-parse', 'HEAD'])
    const wt = await createBranchAndWorktree({
      repoName: 'app',
      localPath: repo,
      worktreesDir: path.join(repo, '..', `wt-${path.basename(repo)}`),
      branch: 'canary/dynamic-ports-x',
    })
    roots.push(wt.handle.worktreeRoot)
    expect(wt.baseSha).toBe(headRev.stdout.trim())

    // The scratch branch is checked out in the worktree.
    const cur = await runGit(wt.handle.worktreeRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(cur.stdout.trim()).toBe('canary/dynamic-ports-x')

    // Edit → diff + changed files reflect it (this diff becomes the overlay).
    fs.appendFileSync(path.join(wt.handle.worktreeRoot, 'app.js'), '// injectable\n')
    const diff = await captureDiff(wt.handle.worktreeRoot, wt.snapshotRef)
    expect(diff).toContain('injectable')
    expect(await changedFiles(wt.handle.worktreeRoot, wt.snapshotRef)).toContain('app.js')

    // Discard removes the worktree dir and deletes the scratch branch — NOTHING
    // is committed to the product repo.
    await discardWorktree(wt.handle, 'canary/dynamic-ports-x')
    expect(fs.existsSync(wt.handle.worktreeRoot)).toBe(false)
    const branches = await runGit(repo, ['branch', '--list', 'canary/dynamic-ports-x'])
    expect(branches.stdout.trim()).toBe('')
    // No new commit landed: the only commit is the fixture's init.
    const log = await runGit(repo, ['log', '--oneline'])
    expect(log.stdout.trim().split('\n')).toHaveLength(1)
  })

  it('changedFiles returns [] when git diff fails (non-git path)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-nogit-cf-'))
    roots.push(dir)
    expect(await changedFiles(dir, 'HEAD')).toEqual([])
  })

  it('createBranchAndWorktree throws on a non-git path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-nogit-'))
    roots.push(dir)
    await expect(createBranchAndWorktree({
      repoName: 'x', localPath: dir, worktreesDir: path.join(dir, 'wt'), branch: 'b',
    })).rejects.toBeTruthy()
  })

  it('createBranchAndWorktree throws (and cleans up) when the branch name is invalid', async () => {
    const repo = await tmpRepo()
    await expect(createBranchAndWorktree({
      repoName: 'app', localPath: repo,
      worktreesDir: path.join(repo, '..', `wt-bad-${path.basename(repo)}`),
      branch: 'bad..branch', // git rejects '..' in ref names
    })).rejects.toThrow(/failed to create branch/)
  })
})
