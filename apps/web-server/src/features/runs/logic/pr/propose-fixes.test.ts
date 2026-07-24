import { describe, it, expect } from 'vitest'
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
    expect(fixBranchName('2026-07-23T1603-z6kc', 'merchant-pass'))
      .toBe('canary-lab/fix-2026-07-23t1603-z6kc-merchant-pass')
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
    expect(results).toEqual([{ repoName: 'fnb', ok: true, pr: { repoName: 'fnb', url: 'https://github.com/org/fnb/pull/7', branch: fixBranchName('run-9', 'fnb'), base: 'development', createdAt: 'T' } }])
    // The command sequence lands in order (worktree from baseSha, force-with-lease push).
    const seq = git.calls.map((c) => c[0])
    expect(seq).toContain('worktree')
    expect(git.calls.find((c) => c[0] === 'worktree' && c[1] === 'add')).toEqual(['worktree', 'add', '--detach', '/tmp/wt', 'base123'])
    expect(git.calls.some((c) => c[0] === 'push' && c.includes('--force-with-lease'))).toBe(true)
    expect(git.calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true) // cleaned up
  })

  it('is idempotent: an existing PR short-circuits without pushing', async () => {
    const git = recordingGit()
    const gh = async (args: string[]): Promise<GhResult> =>
      args[1] === 'list' ? ok('https://github.com/org/fnb/pull/3') : ok()
    const results = await proposeFixesForRun({
      runId: 'run-9', feature: 'fnb', fixCapture, preflight,
      deps: { git: git.run, gh, now: () => 'T', tmpWorktreeDir: () => '/tmp/wt' },
    })
    expect(results[0]).toMatchObject({ ok: true, pr: { url: 'https://github.com/org/fnb/pull/3' } })
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false) // never pushed
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
})
