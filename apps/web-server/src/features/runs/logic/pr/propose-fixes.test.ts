import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { proposeFixesForRun, fixBranchName } from './propose-fixes'
import type { RunFixCapture } from '../../../../../../../shared/run-state'
import type { PrPreflight } from './pr-preflight'
import type { GitResult } from '../../../../shared/git-repo'
import type { GhResult } from '../../../../shared/gh-cli'

const ok = (stdout = ''): GitResult & GhResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): GitResult & GhResult => ({ code: 1, stdout: '', stderr })

const fixCapture: RunFixCapture = {
  capturedAt: 'now',
  repos: [{ repoName: 'fnb', patchPath: '/r/fixes/fnb.patch', patchFile: 'fnb.patch', repoRoot: '/repos/fnb', baseSha: 'base123', files: 1 }],
}

const preflight: PrPreflight = {
  gh: { installed: true, authenticated: true, account: 'me', host: 'github.com' },
  anyPushable: true,
  repos: [{ repoName: 'fnb', repoRoot: '/repos/fnb', origin: { owner: 'org', name: 'fnb', host: 'github.com' }, base: 'development', pushable: true }],
}

/** git runner that returns ok for everything, recording the arg sequence. */
function recordingGit(overrides: (args: string[]) => GitResult | null = () => null) {
  const calls: string[][] = []
  const run = async (_cwd: string, args: string[]): Promise<GitResult> => {
    calls.push(args)
    return overrides(args) ?? ok()
  }
  return { run, calls }
}

describe('fixBranchName', () => {
  it('is deterministic and filesystem/ref safe', () => {
    expect(fixBranchName('CNS Line integration', 'merchant-pass'))
      .toBe('canary-lab/fix-cns-line-integration-merchant-pass')
  })

  it('is scoped to the feature, so two runs of it share one branch', () => {
    expect(fixBranchName('fnb', 'repo')).toBe(fixBranchName('fnb', 'repo'))
  })
})

describe('proposeFixesForRun', () => {
  it('opens a PR: worktree → branch → apply → commit → push → gh pr create', async () => {
    const git = recordingGit()
    const ghCalls: string[][] = []
    const gh = async (args: string[]): Promise<GhResult> => {
      ghCalls.push(args)
      if (args[0] === 'pr' && args[1] === 'list') return ok('') // no existing PR
      if (args[0] === 'pr' && args[1] === 'create') return ok('https://github.com/org/fnb/pull/7')
      return ok()
    }
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: git.run, gh, now: () => 'T', tmpWorktreeDir: () => '/tmp/wt' },
    })
    expect(results).toEqual([{ repoName: 'fnb', ok: true, pr: { repoName: 'fnb', url: 'https://github.com/org/fnb/pull/7', branch: fixBranchName('fnb', 'fnb'), base: 'development', createdAt: 'T' } }])
    // The command sequence lands in order (worktree from baseSha, force-with-lease push).
    const seq = git.calls.map((c) => c[0])
    expect(seq).toContain('worktree')
    expect(git.calls.find((c) => c[0] === 'worktree' && c[1] === 'add')).toEqual(['worktree', 'add', '--detach', '/tmp/wt', 'base123'])
    expect(git.calls.some((c) => c[0] === 'push' && c.includes('--force-with-lease'))).toBe(true)
    expect(git.calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true) // cleaned up
    // A plain (non-draft) create is what the user-driven dialog asks for.
    expect(ghCalls.find((c) => c[1] === 'create')).not.toContain('--draft')
  })

  it('fetches the shared branch before pushing so the lease is not stale info', async () => {
    // Second and later runs of a feature push onto a branch this scratch
    // worktree has never seen; `--force-with-lease` rejects that outright
    // unless the remote-tracking ref exists first.
    const git = recordingGit()
    const gh = async (args: string[]): Promise<GhResult> => (args[1] === 'list' ? ok('') : ok('https://github.com/org/fnb/pull/8'))
    await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: git.run, gh, tmpWorktreeDir: () => '/tmp/wt' },
    })
    const fetched = git.calls.find((c) => c[0] === 'fetch')
    expect(fetched).toEqual(['fetch', 'origin', `+refs/heads/${fixBranchName('fnb', 'fnb')}:refs/remotes/origin/${fixBranchName('fnb', 'fnb')}`])
    expect(git.calls.findIndex((c) => c[0] === 'fetch')).toBeLessThan(git.calls.findIndex((c) => c[0] === 'push'))
  })

  it('reuses an open PR on the shared branch — but only AFTER pushing the new fix onto it', async () => {
    const git = recordingGit()
    const ghCalls: string[][] = []
    const gh = async (args: string[]): Promise<GhResult> => {
      ghCalls.push(args)
      return args[1] === 'list' ? ok('https://github.com/org/fnb/pull/3') : ok()
    }
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: git.run, gh, now: () => 'T', tmpWorktreeDir: () => '/tmp/wt' },
    })
    expect(results[0]).toMatchObject({ ok: true, pr: { url: 'https://github.com/org/fnb/pull/3' } })
    // The whole point of the reorder: the existing review thread now carries
    // THIS run's fix instead of the earlier attempt it was opened with.
    expect(git.calls.some((c) => c[0] === 'push')).toBe(true)
    expect(ghCalls.some((c) => c[1] === 'create')).toBe(false) // no duplicate PR
  })

  it('opens a draft PR when the automatic end-of-run trigger asks for one', async () => {
    const ghCalls: string[][] = []
    const gh = async (args: string[]): Promise<GhResult> => {
      ghCalls.push(args)
      return args[1] === 'list' ? ok('') : ok('https://github.com/org/fnb/pull/9')
    }
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight, draft: true,
      deps: { git: recordingGit().run, gh, tmpWorktreeDir: () => '/tmp/wt' },
    })
    expect(results[0].ok).toBe(true)
    expect(ghCalls.find((c) => c[1] === 'create')).toContain('--draft')
  })

  it('reports a per-repo failure when the patch no longer applies', async () => {
    const git = recordingGit((args) => (args[0] === 'apply' ? fail('patch does not apply') : null))
    const gh = async (args: string[]): Promise<GhResult> => (args[1] === 'list' ? ok('') : ok())
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: git.run, gh, tmpWorktreeDir: () => '/tmp/wt' },
    })
    expect(results[0].ok).toBe(false)
    expect(results[0].reason).toMatch(/no longer applies/i)
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false)
  })

  it('skips a non-pushable repo with its blocked reason', async () => {
    const blocked: PrPreflight = { ...preflight, anyPushable: false, repos: [{ ...preflight.repos[0], pushable: false, blocked: { reason: 'wrong-account' } }] }
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight: blocked,
      deps: { git: recordingGit().run, gh: async () => ok() },
    })
    expect(results[0]).toEqual({ repoName: 'fnb', ok: false, reason: 'wrong-account' })
  })

  it('falls back to a generic reason when a repo is unpushable with no blocked detail', async () => {
    // `pushable: false` with no `blocked` block still has to say something.
    const vague: PrPreflight = { ...preflight, anyPushable: false, repos: [{ ...preflight.repos[0], pushable: false }] }
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight: vague,
      deps: { git: recordingGit().run, gh: async () => ok() },
    })
    expect(results[0]).toEqual({ repoName: 'fnb', ok: false, reason: 'repo is not pushable' })
  })

  it('reports a pushable repo that has no captured patch', async () => {
    const git = recordingGit()
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture: { capturedAt: 'now', repos: [] }, preflight,
      deps: { git: git.run, gh: async () => ok(), tmpWorktreeDir: () => '/tmp/wt' },
    })
    expect(results[0]).toEqual({ repoName: 'fnb', ok: false, reason: 'no captured patch for this repo' })
    expect(git.calls).toEqual([]) // never touched the repo
  })

  it('returns an empty result set — and never calls git — when preflight has no repos', async () => {
    // Also the only path that leaves every injectable dep at its real default
    // without running anything against a real repo.
    await expect(proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight: { ...preflight, anyPushable: false, repos: [] },
    })).resolves.toEqual([])
  })

  it('stamps a real timestamp and a tmpdir worktree when now/tmpWorktreeDir are not injected', async () => {
    const git = recordingGit()
    const gh = async (args: string[]): Promise<GhResult> =>
      args[1] === 'list' ? ok('') : ok('https://github.com/org/fnb/pull/11')
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight, deps: { git: git.run, gh },
    })
    expect(results[0].pr?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    const add = git.calls.find((c) => c[0] === 'worktree' && c[1] === 'add')!
    expect(add[3]).toBe(path.join(os.tmpdir(), 'canary-pr-run-9-fnb'))
  })

  it('slugs unsafe run/repo names down to a placeholder for the scratch dir', async () => {
    // `***` has nothing slug-worthy left, so the dir segment falls back to `x`.
    const git = recordingGit()
    const gh = async (args: string[]): Promise<GhResult> =>
      args[1] === 'list' ? ok('') : ok('https://github.com/org/fnb/pull/12')
    const odd: PrPreflight = { ...preflight, repos: [{ ...preflight.repos[0], repoName: '***' }] }
    await proposeFixesForRun({
      runId: '***', feature: 'fnb',
      fixCapture: { capturedAt: 'now', repos: [{ ...fixCapture.repos[0], repoName: '***' }] },
      preflight: odd, deps: { git: git.run, gh },
    })
    const add = git.calls.find((c) => c[0] === 'worktree' && c[1] === 'add')!
    expect(add[3]).toBe(path.join(os.tmpdir(), 'canary-pr-x-x'))
  })

  it('detaches at HEAD when the capture has no baseSha', async () => {
    const git = recordingGit()
    const gh = async (args: string[]): Promise<GhResult> =>
      args[1] === 'list' ? ok('') : ok('https://github.com/org/fnb/pull/13')
    await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb',
      fixCapture: { capturedAt: 'now', repos: [{ ...fixCapture.repos[0], baseSha: '' }] },
      preflight, deps: { git: git.run, gh, tmpWorktreeDir: () => '/tmp/wt' },
    })
    expect(git.calls.find((c) => c[0] === 'worktree' && c[1] === 'add')).toEqual(['worktree', 'add', '--detach', '/tmp/wt', 'HEAD'])
  })

  // Every step between `worktree add` and `gh pr create` must surface its own
  // reason rather than a generic failure — the reason is what the UI shows.
  const STEP_FAILURES: { label: string; when: (args: string[]) => boolean; reason: RegExp }[] = [
    { label: 'worktree add', when: (a) => a[0] === 'worktree' && a[1] === 'add', reason: /scratch worktree/i },
    { label: 'checkout -B', when: (a) => a[0] === 'checkout', reason: /create the fix branch/i },
    { label: 'commit', when: (a) => a[0] === 'commit', reason: /nothing to commit/i },
    { label: 'push', when: (a) => a[0] === 'push', reason: /push to origin was rejected/i },
  ]
  for (const step of STEP_FAILURES) {
    it(`reports the step reason when \`${step.label}\` fails`, async () => {
      const git = recordingGit((args) => (step.when(args) ? fail(`${step.label} exploded`) : null))
      const gh = async (args: string[]): Promise<GhResult> => (args[1] === 'list' ? ok('') : ok())
      const results = await proposeFixesForRun({
        runId: 'run-9', feature: 'fnb', fixCapture, preflight,
        deps: { git: git.run, gh, tmpWorktreeDir: () => '/tmp/wt' },
      })
      expect(results[0].ok).toBe(false)
      expect(results[0].reason).toMatch(step.reason)
      expect(results[0].reason).toContain('exploded')
    })
  }

  it('reports a gh pr create failure', async () => {
    const git = recordingGit()
    const gh = async (args: string[]): Promise<GhResult> =>
      args[1] === 'list' ? ok('') : fail('GraphQL: base branch not found')
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: git.run, gh, tmpWorktreeDir: () => '/tmp/wt' },
    })
    expect(results[0]).toMatchObject({ ok: false, reason: 'gh pr create failed: GraphQL: base branch not found' })
  })

  it('reports a missing URL when gh pr create succeeds but prints nothing', async () => {
    const gh = async (args: string[]): Promise<GhResult> => (args[1] === 'list' ? ok('') : ok('  \n'))
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: recordingGit().run, gh, tmpWorktreeDir: () => '/tmp/wt' },
    })
    expect(results[0]).toEqual({ repoName: 'fnb', ok: false, reason: 'gh pr create returned no URL' })
  })

  it('falls back to stdout, then to a bare "failed", when a step reports no stderr', async () => {
    const gh = async (args: string[]): Promise<GhResult> => (args[1] === 'list' ? ok('') : ok())

    const stdoutOnly = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: {
        git: recordingGit((a) => (a[0] === 'commit' ? { code: 1, stdout: 'nothing added to commit', stderr: '' } : null)).run,
        gh, tmpWorktreeDir: () => '/tmp/wt',
      },
    })
    expect(stdoutOnly[0].reason).toBe('nothing to commit / commit failed: nothing added to commit')

    const silent = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: {
        git: recordingGit((a) => (a[0] === 'commit' ? { code: 1, stdout: '', stderr: '' } : null)).run,
        gh, tmpWorktreeDir: () => '/tmp/wt',
      },
    })
    expect(silent[0].reason).toBe('nothing to commit / commit failed: failed')
  })

  it('removes the scratch directory itself when `git worktree remove` throws', async () => {
    // The finally block is the only guard against leaking a worktree, so it has
    // to survive git rejecting outright.
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-propose-wt-'))
    fs.writeFileSync(path.join(wt, 'leftover.txt'), 'x')
    const git = async (_cwd: string, args: string[]): Promise<GitResult> => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('worktree is locked')
      return ok()
    }
    const gh = async (args: string[]): Promise<GhResult> =>
      args[1] === 'list' ? ok('') : ok('https://github.com/org/fnb/pull/14')

    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git, gh, now: () => 'T', tmpWorktreeDir: () => wt },
    })
    expect(results[0].ok).toBe(true)
    expect(fs.existsSync(wt)).toBe(false)
  })
})

describe('proposeFixesForRun — agent-written wording', () => {
  const written = {
    commitSubject: 'fix(catalog): implement product deletion',
    commitBody: 'DELETE /products/:id answered 405, so a discontinued item\ncould never leave the catalog.',
    prTitle: 'Discontinued products can now be removed',
    prBody: '## What changed\n- `server.ts`: implement the DELETE branch',
  }

  /** git + gh that record everything and report a created PR. */
  function harness() {
    const git = recordingGit()
    const ghCalls: string[][] = []
    const gh = async (args: string[]): Promise<GhResult> => {
      ghCalls.push(args)
      return args[1] === 'list' ? ok('') : ok('https://github.com/org/fnb/pull/7')
    }
    return { git, gh, ghCalls }
  }

  it('commits the agent subject and body as separate -m args', async () => {
    const h = harness()
    await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: h.git.run, gh: h.gh, now: () => 'T', tmpWorktreeDir: () => '/tmp/wt', writeMessage: async () => written },
    })
    const commit = h.git.calls.find((c) => c[0] === 'commit')!
    // Two -m args, not one folded string: git composes the blank line itself,
    // and a single fold would make the whole message the subject line.
    expect(commit.filter((a) => a === '-m')).toHaveLength(2)
    expect(commit[commit.indexOf('-m') + 1]).toBe(written.commitSubject)
    const body = commit[commit.lastIndexOf('-m') + 1]
    expect(body).toContain('could never leave the catalog')
    expect(body).toContain('run `run-9`')
  })

  it('titles and bodies the PR from the agent, keeping provenance exact', async () => {
    const h = harness()
    await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: h.git.run, gh: h.gh, now: () => 'T', tmpWorktreeDir: () => '/tmp/wt', writeMessage: async () => written },
    })
    const create = h.ghCalls.find((c) => c[1] === 'create')!
    expect(create[create.indexOf('--title') + 1]).toBe(written.prTitle)
    const body = create[create.indexOf('--body') + 1]
    expect(body).toContain('implement the DELETE branch')
    // The footer is appended by us, never left to the agent — it is the one
    // part of the body that has to be exactly right.
    expect(body).toContain('run `run-9`')
    expect(body).toContain('`base123`')
  })

  it('falls back to the deterministic wording when no agent could write one', async () => {
    const h = harness()
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: h.git.run, gh: h.gh, now: () => 'T', tmpWorktreeDir: () => '/tmp/wt', writeMessage: async () => null },
    })
    expect(results[0].ok).toBe(true)
    const commit = h.git.calls.find((c) => c[0] === 'commit')!
    expect(commit.filter((a) => a === '-m')).toHaveLength(1)
    expect(commit[commit.indexOf('-m') + 1]).toBe('fix(fnb): canary-lab heal fixes from run run-9')
    const create = h.ghCalls.find((c) => c[1] === 'create')!
    expect(create[create.indexOf('--title') + 1]).toBe('fix(fnb): canary-lab heal fixes')
  })

  it('still opens the PR when the message agent throws', async () => {
    // A dull message beats no pull request.
    const h = harness()
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: {
        git: h.git.run, gh: h.gh, now: () => 'T', tmpWorktreeDir: () => '/tmp/wt',
        writeMessage: async () => { throw new Error('claude is not installed') },
      },
    })
    expect(results[0].ok).toBe(true)
    expect(h.ghCalls.some((c) => c[1] === 'create')).toBe(true)
  })
})
