import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import {
  describeRepoUpdates,
  reposToUpdate,
  updatedFromUpstreamByRepo,
  updateReposToUpstream,
  type RepoUpdateReport,
} from './repo-upstream-update'

// The per-run policy over `fastForwardToUpstream`: which repos, what an active
// run means, and the one 409 that names every refusal. The git edge cases
// themselves are `shared/git-upstream.test.ts`'s subject; here one behind
// checkout and one dirty checkout are enough to drive every arm.

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A clone one commit behind its bare origin. */
function behindClone(): { clone: string; from: string; to: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-repo-update-')))
  made.push(root)
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const clone = path.join(root, 'clone')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  fs.mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'config', 'user.email', 'test@example.com')
  git(seed, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(seed, 'README.md'), 'hello\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', 'init')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', '-u', 'origin', 'main')
  git(root, 'clone', '-q', origin, clone)
  const from = git(clone, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(seed, 'next.txt'), 'next\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', 'next')
  git(seed, 'push', '-q', 'origin', 'main')
  return { clone, from, to: git(seed, 'rev-parse', 'HEAD') }
}

function feature(repos: FeatureConfig['repos']): FeatureConfig {
  return { name: 'demo', description: 'd', envs: [], featureDir: '/features/demo', repos }
}

const notInUse = { inUseBy: () => null }

describe('reposToUpdate', () => {
  const tracked = { name: 'tracked', localPath: '/r/tracked', track: 'upstream' as const }
  const pinnedOnly = { name: 'pinned', localPath: '/r/pinned', branch: 'main' }
  const badPath = { name: 'bad', localPath: 42 as unknown as string, track: 'upstream' as const }

  it('defaults to the repos that opted in with track: upstream', () => {
    expect(reposToUpdate(feature([tracked, pinnedOnly, badPath]), undefined)).toEqual([tracked])
  })

  it('updates every repo with a usable path when the run asks for all, and none when it declines', () => {
    expect(reposToUpdate(feature([tracked, pinnedOnly, badPath]), true)).toEqual([tracked, pinnedOnly])
    expect(reposToUpdate(feature([tracked, pinnedOnly]), false)).toEqual([])
  })

  it('has nothing to update for a repo-less feature', () => {
    expect(reposToUpdate(feature(undefined), true)).toEqual([])
  })
})

describe('updateReposToUpstream', () => {
  it('fast-forwards the selected repos and reports each outcome by name', async () => {
    const { clone, from, to } = behindClone()

    const report = await updateReposToUpstream(
      feature([{ name: 'app', localPath: clone, branch: 'main', track: 'upstream' }]),
      undefined,
      notInUse,
    )

    expect(report).toEqual({
      app: { kind: 'fast-forwarded', branch: 'main', upstream: 'origin/main', from, to, behind: 1 },
    })
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(to)
  })

  it('touches nothing when the run declines the update', async () => {
    const { clone, from } = behindClone()

    await expect(updateReposToUpstream(
      feature([{ name: 'app', localPath: clone, track: 'upstream' }]),
      false,
      notInUse,
    )).resolves.toEqual({})
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from)
  })

  it('collects every refusal into one typed 409, checking all repos before giving up', async () => {
    const dirty = behindClone()
    fs.writeFileSync(path.join(dirty.clone, 'README.md'), 'edited\n')
    const held = behindClone()
    const clean = behindClone()

    const err = await updateReposToUpstream(
      feature([
        { name: 'dirty', localPath: dirty.clone, branch: 'main' },
        { name: 'held', localPath: held.clone },
        { name: 'clean', localPath: clean.clone, branch: 'main' },
      ]),
      true,
      { inUseBy: (repoPath) => (repoPath === held.clone ? 'run-42' : null) },
    ).catch((e: unknown) => e) as Error & { statusCode: number; repoUpdate: unknown[] }

    expect(err).toBeInstanceOf(Error)
    expect(err.statusCode).toBe(409)
    expect(err.repoUpdate).toEqual([
      {
        name: 'dirty', path: dirty.clone, branch: 'main', reason: 'dirty',
        message: expect.stringContaining('uncommitted changes'),
      },
      {
        name: 'held', path: held.clone, branch: null, reason: 'in-use',
        message: 'run run-42 is booted from this checkout in place; wait for it or queue behind it',
      },
    ])
    expect(err.message).toBe(
      `Repo upstream update refused:\ndirty: ${(err.repoUpdate[0] as { message: string }).message}\nheld: run run-42 is booted from this checkout in place; wait for it or queue behind it`,
    )
    // Refused repos are left alone; the clean one WAS fast-forwarded before
    // the refusal was raised, which is fine — a fast-forward is never harmful
    // and the run start that follows sees the same tip either way.
    expect(git(dirty.clone, 'rev-parse', 'HEAD')).toBe(dirty.from)
    expect(git(held.clone, 'rev-parse', 'HEAD')).toBe(held.from)
    expect(git(clean.clone, 'rev-parse', 'HEAD')).toBe(clean.to)
  })
})

describe('report helpers', () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const report: RepoUpdateReport = {
    app: { kind: 'fast-forwarded', branch: 'main', upstream: 'origin/main', from: a, to: b, behind: 2 },
    api: { kind: 'up-to-date', branch: 'main', upstream: 'origin/main', sha: a },
    lib: { kind: 'no-upstream', branch: 'main', sha: null },
  }

  it('keeps only the fast-forwards, in the snapshot shape', () => {
    expect(updatedFromUpstreamByRepo(report)).toEqual({ app: { upstream: 'origin/main', from: a, to: b } })
  })

  it('renders one runner-log line per repo looked at', () => {
    expect(describeRepoUpdates(report)).toEqual([
      'Upstream update for "app": fast-forwarded main aaaaaaa → bbbbbbb (2 commit(s) from origin/main)',
      'Upstream update for "api": main already at origin/main (aaaaaaa)',
      'Upstream update for "lib": main tracks no upstream; booting the checked-out commit',
    ])
  })
})
