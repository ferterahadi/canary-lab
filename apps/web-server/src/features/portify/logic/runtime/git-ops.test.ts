import fs from 'fs'
import * as childProcess from 'child_process'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runGit } from '../../../../shared/git-repo'
import {
  portifyBranchName,
  createBranchAndWorktree,
  captureDiff,
  changedFiles,
  discardWorktree,
  editFingerprint,
} from './git-ops'
import { initGitRepo } from '../../../../../../../tools/test-helpers/git-repo'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('portify-git-')

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

const roots: string[] = []
afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

function tmpRepo(): string {
  const root = tempDir()
  fs.writeFileSync(path.join(root, 'app.js'), 'const PORT = 3007\n')
  initGitRepo(root)
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
    const dir = tempDir('portify-nogit-cf-')
    expect(await changedFiles(dir, 'HEAD')).toEqual([])
  })

  it('createBranchAndWorktree throws on a non-git path', async () => {
    const dir = tempDir('portify-nogit-')
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

// The liveness fingerprint behind the external-portify abandonment fix: while an
// external client holds the editing window, `status` and `attempt` are pinned, so
// this is the only signal that distinguishes "still working" from "vanished".
describe('editFingerprint', () => {
  it('moves when a file is edited, and again when the SAME file changes again', async () => {
    const root = await tmpRepo()
    const before = await editFingerprint([{ worktreePath: root }])
    expect(before.files).toBe(0)

    fs.writeFileSync(path.join(root, 'app.js'), 'const PORT = process.env.PORT\n')
    const first = await editFingerprint([{ worktreePath: root }])
    expect(first.files).toBe(1)
    expect(first.digest).not.toBe(before.digest)

    // A name-list fingerprint would freeze here — the file set is unchanged. The
    // digest folds in the file mtime, so continued work on one file still reads
    // as progress. That is the whole point: a long single-file edit must not look
    // idle and get the workflow abandoned.
    fs.writeFileSync(path.join(root, 'app.js'), 'const PORT = process.env.PORT ?? 3000\n')
    const second = await editFingerprint([{ worktreePath: root }])
    expect(second.files).toBe(1)
    expect(second.digest).not.toBe(first.digest)
  })

  it.each(['with space.txt', 'tab\tfile.txt', 'café.txt', 'quote"file.txt', 'back\\slash.txt', 'left -> right.txt', ' padded '])('detects repeated edits of %j with a stable count', async (name) => {
    const root = await tmpRepo()
    await runGit(root, ['config', 'core.quotePath', 'true'])
    const file = path.join(root, name)
    fs.writeFileSync(file, 'first edit')
    fs.utimesSync(file, 1700000000, 1700000000)
    const first = await editFingerprint([{ worktreePath: root }])
    expect(first.files).toBe(1)
    expect(await editFingerprint([{ worktreePath: root }])).toEqual(first)
    fs.writeFileSync(file, 'second edit')
    fs.utimesSync(file, 1700000002, 1700000002)
    const second = await editFingerprint([{ worktreePath: root }])
    expect(second.files).toBe(1)
    expect(second.digest).not.toBe(first.digest)
  })

  it('preserves ordinary-path digest bytes and inspects once without refreshing the index', async () => {
    const root = await tmpRepo()
    const index = path.join(root, '.git', 'index')
    const bytes = fs.readFileSync(index)
    const mtime = fs.statSync(index, { bigint: true }).mtimeNs
    const file = path.join(root, 'app.js')
    fs.utimesSync(file, 1700000000, 1700000000)
    const exec = vi.mocked(childProcess.execFile).mockClear()
    try {
      expect(await editFingerprint([{ worktreePath: root }])).toEqual({ digest: '1:3t0v', files: 0 })
      expect(exec).toHaveBeenCalledExactlyOnceWith('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: root }, expect.any(Function))
      expect(fs.readFileSync(index)).toEqual(bytes)
      expect(fs.statSync(index, { bigint: true }).mtimeNs).toBe(mtime)
      fs.writeFileSync(file, 'edited')
      fs.utimesSync(file, 1700000000, 1700000000)
      expect(await editFingerprint([{ worktreePath: root }])).toEqual({ digest: '31:85gfbq', files: 1 })
    } finally { exec.mockRestore() }
  })

  it('counts UNTRACKED files too — adding a file is progress', async () => {
    const root = await tmpRepo()
    fs.writeFileSync(path.join(root, 'ports.js'), 'module.exports = {}\n')
    const fp = await editFingerprint([{ worktreePath: root }])
    expect(fp.files).toBe(1)
  })

  it('is stable when nothing changes, so a vanished client still hits the idle budget', async () => {
    const root = await tmpRepo()
    fs.writeFileSync(path.join(root, 'app.js'), 'edited\n')
    const a = await editFingerprint([{ worktreePath: root }])
    const b = await editFingerprint([{ worktreePath: root }])
    expect(b.digest).toBe(a.digest)
  })

  it('sums across every scratch worktree and skips repos with no worktree yet', async () => {
    const one = await tmpRepo()
    const two = await tmpRepo()
    fs.writeFileSync(path.join(one, 'app.js'), 'a\n')
    fs.writeFileSync(path.join(two, 'app.js'), 'b\n')
    const fp = await editFingerprint([{ worktreePath: one }, {}, { worktreePath: two }])
    expect(fp.files).toBe(2)
    expect(fp.digest.split('|')).toHaveLength(2)
  })

  it('still fingerprints a DELETED file, which porcelain lists but cannot be stat-ed', async () => {
    // ` D server.js` is real progress (removing a hardcoded-port file counts), and
    // the mtime lookup must degrade to the path rather than throwing the whole
    // fingerprint away — otherwise a delete-only edit session looks idle.
    const root = await tmpRepo()
    fs.rmSync(path.join(root, 'app.js'))
    const fp = await editFingerprint([{ worktreePath: root }])
    expect(fp.files).toBe(1)
    expect(fp.digest).not.toBe('')
    expect(fp.digest).not.toBe('unreadable')
  })

  it('resolves a RENAMED path to its new name, which is the one on disk', async () => {
    // Porcelain renders a staged rename as `R  old -> new`; stat-ing the OLD name
    // would always miss, silently dropping the mtime component for exactly the
    // edit most likely to happen when a client reorganises port wiring.
    const root = await tmpRepo()
    await runGit(root, ['mv', 'app.js', 'server.js'])
    const fp = await editFingerprint([{ worktreePath: root }])
    expect(fp.files).toBe(1)
    // The new name is stat-able, so the digest carries a real mtime rather than a
    // bare path — proving the arrow was parsed.
    expect(fp.digest).toMatch(/^\d+:/)
    expect(fp.digest).not.toBe('unreadable')
  })

  it('does not report a partial file count when one worktree is unreadable', async () => {
    const root = await tmpRepo()
    fs.writeFileSync(path.join(root, 'app.js'), 'changed')
    const fp = await editFingerprint([{ worktreePath: path.join(root, 'missing') }, { worktreePath: root }])
    expect(fp.files).toBeNull()
    expect(fp.digest.split('|')).toHaveLength(2)
  })

  it('reports an unreadable worktree as a marker, never as "no progress"', async () => {
    // A git failure resolving to an empty/stable fingerprint would resurrect the
    // abandonment this guards against, so it must be distinguishable.
    const fp = await editFingerprint([{ worktreePath: path.join(os.tmpdir(), 'definitely-not-a-repo-xyz') }])
    expect(fp.digest).toBe('unreadable')
    expect(fp.files).toBeNull()
  })
})
