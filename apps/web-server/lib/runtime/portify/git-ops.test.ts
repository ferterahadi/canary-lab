import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../../git-repo'
import {
  portifyBranchName,
  createBranchAndWorktree,
  captureDiff,
  changedFiles,
  commitWorktree,
  discardWorktree,
  mergeStatus,
  mergePortifyBranch,
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

describe('git-ops worktree lifecycle', () => {
  it('creates a branch + worktree off HEAD, captures diff, commits, and discards', async () => {
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

    // The branch is checked out in the worktree.
    const cur = await runGit(wt.handle.worktreeRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(cur.stdout.trim()).toBe('canary/dynamic-ports-x')

    // Edit → diff + changed files reflect it.
    fs.appendFileSync(path.join(wt.handle.worktreeRoot, 'app.js'), '// injectable\n')
    const diff = await captureDiff(wt.handle.worktreeRoot, wt.snapshotRef)
    expect(diff).toContain('injectable')
    expect(await changedFiles(wt.handle.worktreeRoot, wt.snapshotRef)).toContain('app.js')

    // Commit returns a SHA; the branch now points at it.
    const sha = await commitWorktree(wt.handle.worktreeRoot, 'feat: ports')
    expect(sha).toMatch(/^[0-9a-f]{7,}$/)

    // Discard removes the worktree dir and deletes the branch.
    await discardWorktree(wt.handle, 'canary/dynamic-ports-x')
    expect(fs.existsSync(wt.handle.worktreeRoot)).toBe(false)
    const branches = await runGit(repo, ['branch', '--list', 'canary/dynamic-ports-x'])
    expect(branches.stdout.trim()).toBe('')
  })

  it('changedFiles returns [] when git diff fails (non-git path)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-nogit-cf-'))
    roots.push(dir)
    expect(await changedFiles(dir, 'HEAD')).toEqual([])
  })

  it('commitWorktree returns null when there is nothing to commit', async () => {
    const repo = await tmpRepo()
    const wt = await createBranchAndWorktree({
      repoName: 'app',
      localPath: repo,
      worktreesDir: path.join(repo, '..', `wt2-${path.basename(repo)}`),
      branch: 'canary/dynamic-ports-empty',
    })
    roots.push(wt.handle.worktreeRoot)
    expect(await commitWorktree(wt.handle.worktreeRoot, 'noop')).toBeNull()
    await discardWorktree(wt.handle, 'canary/dynamic-ports-empty')
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

// Create a portify-like branch carrying one commit, then return to main.
async function repoWithBranch(branch: string, edit = '// injectable\n'): Promise<string> {
  const repo = await tmpRepo()
  await runGit(repo, ['branch', '-M', 'main'])
  await runGit(repo, ['checkout', '-q', '-b', branch])
  fs.appendFileSync(path.join(repo, 'app.js'), edit)
  await runGit(repo, ['add', '-A'])
  await runGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ports', '--no-verify'])
  await runGit(repo, ['checkout', '-q', 'main'])
  return repo
}

describe('mergeStatus', () => {
  it('reports a clean repo with an unmerged branch', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-a')
    const s = await mergeStatus(repo, 'canary/dynamic-ports-a')
    expect(s).toEqual({
      branchExists: true,
      currentBranch: 'main',
      dirty: false,
      mergeInProgress: false,
      merged: false,
    })
  })

  it('reports merged=true once the branch tip is an ancestor of HEAD (manual merges count)', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-b')
    await runGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-edit', 'canary/dynamic-ports-b'])
    const s = await mergeStatus(repo, 'canary/dynamic-ports-b')
    expect(s.merged).toBe(true)
  })

  it('checks merged-ness via the commit sha when the branch was deleted after merging', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-c')
    const tip = (await runGit(repo, ['rev-parse', 'canary/dynamic-ports-c'])).stdout.trim()
    await runGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-edit', 'canary/dynamic-ports-c'])
    await runGit(repo, ['branch', '-d', 'canary/dynamic-ports-c'])
    const s = await mergeStatus(repo, 'canary/dynamic-ports-c', tip)
    expect(s.branchExists).toBe(false)
    expect(s.merged).toBe(true)
  })

  it('reports a dirty working tree', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-d')
    fs.appendFileSync(path.join(repo, 'app.js'), '// wip\n')
    const s = await mergeStatus(repo, 'canary/dynamic-ports-d')
    expect(s.dirty).toBe(true)
  })

  it('reports a missing branch and a detached HEAD', async () => {
    const repo = await tmpRepo()
    await runGit(repo, ['checkout', '-q', '--detach', 'HEAD'])
    const s = await mergeStatus(repo, 'canary/dynamic-ports-none')
    expect(s.branchExists).toBe(false)
    expect(s.currentBranch).toBeNull()
    expect(s.merged).toBe(false)
  })
})

describe('mergePortifyBranch', () => {
  it('merges the branch into the current branch and returns the new HEAD sha', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-m')
    const out = await mergePortifyBranch(repo, 'canary/dynamic-ports-m')
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.mergeCommitSha).toMatch(/^[0-9a-f]{7,}$/)
      expect(out.alreadyMerged).toBe(false)
    }
    expect((await mergeStatus(repo, 'canary/dynamic-ports-m')).merged).toBe(true)
    // The user's file actually has the change.
    expect(fs.readFileSync(path.join(repo, 'app.js'), 'utf-8')).toContain('injectable')
  })

  it('is idempotent — merging an already-merged branch reports alreadyMerged', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-i')
    await mergePortifyBranch(repo, 'canary/dynamic-ports-i')
    const again = await mergePortifyBranch(repo, 'canary/dynamic-ports-i')
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.alreadyMerged).toBe(true)
  })

  it('aborts on conflict, leaves the repo clean, and lists the conflicted files', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-x', 'const PORT = process.env.PORT\n')
    // Conflicting edit on main: same line, different content, committed.
    fs.writeFileSync(path.join(repo, 'app.js'), 'const PORT = 9999\n')
    await runGit(repo, ['add', '-A'])
    await runGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'clash', '--no-verify'])

    const out = await mergePortifyBranch(repo, 'canary/dynamic-ports-x')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.conflictFiles).toContain('app.js')

    // Aborted: tree clean, no merge in progress, HEAD still on main.
    const s = await mergeStatus(repo, 'canary/dynamic-ports-x')
    expect(s.dirty).toBe(false)
    expect(s.mergeInProgress).toBe(false)
    expect(s.currentBranch).toBe('main')
    expect(s.merged).toBe(false)
  })

  it('refuses to merge when a merge is already in progress', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-p', 'const PORT = process.env.PORT\n')
    // Create a conflicting commit on main so the merge will fail and leave MERGE_HEAD.
    fs.writeFileSync(path.join(repo, 'app.js'), 'const PORT = 9999\n')
    await runGit(repo, ['add', '-A'])
    await runGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'clash', '--no-verify'])
    // Trigger the conflicting merge manually — it fails, leaving MERGE_HEAD set.
    await runGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-edit', 'canary/dynamic-ports-p'])
    await expect(mergePortifyBranch(repo, 'canary/dynamic-ports-p')).rejects.toThrow(/merge is already in progress/)
  })

  it('refuses to merge when the working tree is dirty', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-w')
    fs.appendFileSync(path.join(repo, 'app.js'), '// wip\n')
    await expect(mergePortifyBranch(repo, 'canary/dynamic-ports-w')).rejects.toThrow(/uncommitted changes/)
  })

  it('refuses to merge onto a detached HEAD', async () => {
    const repo = await repoWithBranch('canary/dynamic-ports-h')
    await runGit(repo, ['checkout', '-q', '--detach', 'HEAD'])
    await expect(mergePortifyBranch(repo, 'canary/dynamic-ports-h')).rejects.toThrow(/detached/)
  })

  it('refuses to merge a branch that does not exist', async () => {
    const repo = await tmpRepo()
    await expect(mergePortifyBranch(repo, 'canary/dynamic-ports-gone')).rejects.toThrow(/does not exist/)
  })
})
