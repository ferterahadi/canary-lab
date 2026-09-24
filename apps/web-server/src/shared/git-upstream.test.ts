import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  describeFastForward,
  describeRepoCheckout,
  fastForwardToUpstream,
  getUpstreamStatus,
  type FastForwardOutcome,
} from './git-upstream'

// Real git against a bare "origin" and a clone of it: the fast-forward's whole
// contract is what it refuses to do to a working tree, and only git itself can
// say whether a merge would have discarded anything.

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commit(cwd: string, file: string, contents: string, message = `add ${file}`): string {
  fs.writeFileSync(path.join(cwd, file), contents)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

function identity(cwd: string): void {
  git(cwd, 'config', 'user.email', 'test@example.com')
  git(cwd, 'config', 'user.name', 'Test')
}

/** A bare origin holding `main`, a `seed` working copy that pushes to it, and a
 *  `clone` whose `main` tracks `origin/main` — the shape a feature checkout has. */
function tracked(): { origin: string; seed: string; clone: string } {
  const root = tmp('cl-upstream-')
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const clone = path.join(root, 'clone')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  fs.mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  identity(seed)
  commit(seed, 'README.md', 'hello\n', 'init')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', '-u', 'origin', 'main')
  git(root, 'clone', '-q', origin, clone)
  identity(clone)
  return { origin, seed, clone }
}

/** Advance origin/main by one commit the clone has not seen. */
function advanceUpstream(seed: string, file = 'upstream.txt'): string {
  const sha = commit(seed, file, 'from upstream\n')
  git(seed, 'push', '-q', 'origin', 'main')
  return sha
}

describe('fastForwardToUpstream', () => {
  it('fast-forwards a clean checkout that is behind, and is then up to date', async () => {
    const { seed, clone } = tracked()
    const from = git(clone, 'rev-parse', 'HEAD')
    const to = advanceUpstream(seed)

    await expect(fastForwardToUpstream(clone)).resolves.toEqual({
      kind: 'fast-forwarded', branch: 'main', upstream: 'origin/main', from, to, behind: 1,
    })
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(to)
    expect(fs.existsSync(path.join(clone, 'upstream.txt'))).toBe(true)

    await expect(fastForwardToUpstream(clone)).resolves.toEqual({
      kind: 'up-to-date', branch: 'main', upstream: 'origin/main', sha: to,
    })
  })

  it('refuses a dirty checkout and leaves both the tree and HEAD alone', async () => {
    const { seed, clone } = tracked()
    const before = git(clone, 'rev-parse', 'HEAD')
    advanceUpstream(seed)
    fs.writeFileSync(path.join(clone, 'README.md'), 'edited locally\n')
    fs.writeFileSync(path.join(clone, 'scratch.txt'), 'wip\n')

    const outcome = await fastForwardToUpstream(clone)

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'dirty', branch: 'main' })
    expect((outcome as { message: string }).message).toContain('2 file(s)')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before)
    expect(fs.readFileSync(path.join(clone, 'README.md'), 'utf8')).toBe('edited locally\n')
  })

  it('refuses a diverged checkout rather than merging or rebasing local commits', async () => {
    const { seed, clone } = tracked()
    advanceUpstream(seed)
    const local = commit(clone, 'local.txt', 'mine\n')

    const outcome = await fastForwardToUpstream(clone)

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'diverged', branch: 'main' })
    expect((outcome as { message: string }).message).toContain('1 local commit(s)')
    expect((outcome as { message: string }).message).toContain('1 behind origin/main')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(local)
  })

  it('treats a checkout that is only ahead as a no-op, not a failure', async () => {
    const { clone } = tracked()
    const local = commit(clone, 'local.txt', 'mine\n')

    await expect(fastForwardToUpstream(clone)).resolves.toEqual({
      kind: 'ahead', branch: 'main', upstream: 'origin/main', sha: local, ahead: 1,
    })
  })

  it('reports a branch with no upstream as nothing to do', async () => {
    const dir = tmp('cl-noupstream-')
    git(dir, 'init', '-q', '-b', 'main')
    identity(dir)
    const sha = commit(dir, 'a.txt', 'a\n')

    await expect(fastForwardToUpstream(dir)).resolves.toEqual({ kind: 'no-upstream', branch: 'main', sha })
  })

  it('refuses a non-repo, a detached HEAD, and a checkout on the wrong branch', async () => {
    const plain = tmp('cl-plain-')
    await expect(fastForwardToUpstream(plain)).resolves.toMatchObject({ kind: 'refused', reason: 'not-a-git-repo', branch: null })

    const { clone } = tracked()
    git(clone, 'checkout', '-q', '-b', 'topic')
    await expect(fastForwardToUpstream(clone, { branch: 'main' })).resolves.toMatchObject({
      kind: 'refused', reason: 'wrong-branch', branch: 'topic', message: 'checkout is on topic, not main',
    })

    git(clone, 'checkout', '-q', '--detach')
    await expect(fastForwardToUpstream(clone)).resolves.toMatchObject({ kind: 'refused', reason: 'detached', branch: null })
  })

  it('refuses when the remote cannot be fetched, but honours fetch:false against the last fetch', async () => {
    const { seed, clone } = tracked()
    const from = git(clone, 'rev-parse', 'HEAD')
    const to = advanceUpstream(seed)
    // The tracking ref knows about the new tip; the remote then goes away.
    git(clone, 'fetch', '-q', 'origin')
    git(clone, 'remote', 'set-url', 'origin', path.join(clone, 'nowhere.git'))

    const failed = await fastForwardToUpstream(clone)
    expect(failed).toMatchObject({ kind: 'refused', reason: 'fetch-failed', branch: 'main' })
    expect((failed as { message: string }).message).toContain('could not fetch origin/main')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from)

    await expect(fastForwardToUpstream(clone, { fetch: false })).resolves.toEqual({
      kind: 'fast-forwarded', branch: 'main', upstream: 'origin/main', from, to, behind: 1,
    })
  })

  it('surfaces a merge git could not complete, with HEAD left where it was', async () => {
    const { seed, clone } = tracked()
    const before = git(clone, 'rev-parse', 'HEAD')
    advanceUpstream(seed, 'generated.txt')
    // A work tree git cannot write the incoming file into: the fast-forward's
    // checkout half fails, so the ref half never happens.
    fs.chmodSync(clone, 0o555)
    try {
      const outcome = await fastForwardToUpstream(clone)

      expect(outcome).toMatchObject({ kind: 'refused', reason: 'merge-failed', branch: 'main' })
      expect((outcome as { message: string }).message).toContain('generated.txt')
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(before)
    } finally {
      fs.chmodSync(clone, 0o755)
    }
  })
})

describe('getUpstreamStatus', () => {
  it('counts ahead/behind locally by default and against the remote tip when asked to fetch', async () => {
    const { seed, clone } = tracked()
    const branchSha = git(clone, 'rev-parse', 'HEAD')
    const tip = advanceUpstream(seed)

    // Nothing fetched yet: the tracking ref still points at the old tip.
    await expect(getUpstreamStatus(clone)).resolves.toEqual({
      branch: 'main', upstream: 'origin/main', branchSha, upstreamSha: branchSha, aheadUpstream: 0, behindUpstream: 0,
    })
    await expect(getUpstreamStatus(clone, { fetch: true })).resolves.toEqual({
      branch: 'main', upstream: 'origin/main', branchSha, upstreamSha: tip, aheadUpstream: 0, behindUpstream: 1,
    })
  })

  it('reports a failed fetch beside the stale counts instead of hiding them', async () => {
    const { seed, clone } = tracked()
    const branchSha = git(clone, 'rev-parse', 'HEAD')
    const tip = advanceUpstream(seed)
    git(clone, 'fetch', '-q', 'origin')
    git(clone, 'remote', 'set-url', 'origin', path.join(clone, 'nowhere.git'))

    const status = await getUpstreamStatus(clone, { fetch: true })

    expect(status).toMatchObject({ branch: 'main', branchSha, upstreamSha: tip, behindUpstream: 1, aheadUpstream: 0 })
    expect(status.fetchError).toContain('nowhere.git')
  })

  it('describes a pinned branch that does not exist locally, a detached HEAD and a non-repo', async () => {
    const { clone } = tracked()
    await expect(getUpstreamStatus(clone, { branch: 'release/next' })).resolves.toEqual({
      branch: 'release/next', upstream: null, branchSha: null, upstreamSha: null, aheadUpstream: null, behindUpstream: null,
    })

    const sha = git(clone, 'rev-parse', 'HEAD')
    git(clone, 'checkout', '-q', '--detach')
    await expect(getUpstreamStatus(clone)).resolves.toEqual({
      branch: null, upstream: null, branchSha: sha, upstreamSha: null, aheadUpstream: null, behindUpstream: null,
    })

    await expect(getUpstreamStatus(tmp('cl-plain-'))).resolves.toEqual({
      branch: null, upstream: null, branchSha: null, upstreamSha: null, aheadUpstream: null, behindUpstream: null,
    })
  })
})

describe('describeFastForward', () => {
  it('renders one line per outcome kind', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const cases: Array<[FastForwardOutcome, string]> = [
      [{ kind: 'fast-forwarded', branch: 'main', upstream: 'origin/main', from: a, to: b, behind: 3 },
        'fast-forwarded main aaaaaaa → bbbbbbb (3 commit(s) from origin/main)'],
      [{ kind: 'up-to-date', branch: 'main', upstream: 'origin/main', sha: a }, 'main already at origin/main (aaaaaaa)'],
      [{ kind: 'ahead', branch: 'main', upstream: 'origin/main', sha: a, ahead: 2 }, 'main is 2 commit(s) ahead of origin/main; nothing to pull'],
      [{ kind: 'no-upstream', branch: 'main', sha: a }, 'main tracks no upstream; booting the checked-out commit'],
      [{ kind: 'refused', reason: 'dirty', message: 'uncommitted changes', branch: 'main' }, 'refused (dirty): uncommitted changes'],
    ]
    for (const [outcome, text] of cases) expect(describeFastForward(outcome)).toBe(text)
  })
})

describe('describeRepoCheckout', () => {
  it('merges git status, upstream standing and the feature expectations', async () => {
    const { seed, clone } = tracked()
    const tip = advanceUpstream(seed)

    const status = await describeRepoCheckout({ name: 'app', localPath: clone, branch: 'main', track: 'upstream' }, { fetch: true })

    expect(status).toMatchObject({
      isGitRepo: true,
      currentBranch: 'main',
      headSha: git(clone, 'rev-parse', 'HEAD'),
      branch: 'main',
      upstream: 'origin/main',
      upstreamSha: tip,
      behindUpstream: 1,
      aheadUpstream: 0,
      path: clone,
      expectedBranch: 'main',
      trackUpstream: true,
    })
  })

  it('reports a non-repo path with every upstream field null', async () => {
    const plain = tmp('cl-plain-')

    await expect(describeRepoCheckout({ name: 'app', localPath: plain })).resolves.toMatchObject({
      isGitRepo: false,
      headSha: null,
      branch: null,
      upstream: null,
      behindUpstream: null,
      path: plain,
      expectedBranch: null,
      trackUpstream: false,
    })
  })
})
