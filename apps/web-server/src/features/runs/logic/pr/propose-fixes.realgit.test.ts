import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixBranchName, proposeFixesForRun } from './propose-fixes'
import { runGit, type GitResult } from '../../../../shared/git-repo'
import type { GhResult } from '../../../../shared/gh-cli'
import type { PrPreflight } from './pr-preflight'
import type { RunFixCapture } from '../../../../../../../shared/run-state'

// Real git, stubbed gh. A `git init --bare` directory stands in for GitHub, so
// worktree add → fetch → checkout -B → apply → commit → push all execute for
// real; only the two `gh` calls are faked, because nothing short of github.com
// can answer them. This works because `proposeFixesForRun` takes the preflight
// as DATA and never re-derives it — the GitHub-shaped owner/name slug reaches
// `gh` only, while `git push` targets the remote NAMED origin, whatever it is.
//
// What this buys that the mocked-git suite cannot: the `--force-with-lease`
// stale-info rejection is a real git behaviour, invisible to a stub. Its guard
// (the fetch at propose-fixes.ts) only bites when the branch exists on origin
// and the pushing clone has no remote-tracking ref for it — so run ONE always
// passes and only a later run can expose a regression. Test 2 reproduces that
// state deliberately; test 3 removes the guard and shows the push rejected.

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const BRANCH = fixBranchName('checkout', 'svc')

interface Fixture {
  product: string
  origin: string
  baseSha: string
  patches: string[]
}

/** A product repo wired to a bare origin, plus two successive repair patches
 *  written out the way `captureFixes` writes them. */
function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pr-realgit-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const product = path.join(root, 'product')
  const fixesDir = path.join(root, 'fixes')
  fs.mkdirSync(fixesDir)
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', product])
  const git = (args: string[]): string => execFileSync('git', args, { cwd: product, encoding: 'utf-8' })
  git(['config', 'user.email', 'proof@local'])
  git(['config', 'user.name', 'proof'])
  fs.writeFileSync(path.join(product, 'server.js'), 'const PORT = 3000\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
  git(['remote', 'add', 'origin', origin])
  git(['push', '-q', '-u', 'origin', 'main'])
  const baseSha = git(['rev-parse', 'HEAD']).trim()

  const patches = ['const PORT = process.env.PORT || 3000\n', 'const PORT = Number(process.env.PORT) || 3000\n']
    .map((body, i) => {
      fs.writeFileSync(path.join(product, 'server.js'), body)
      const out = path.join(fixesDir, `fix-${i}.patch`)
      fs.writeFileSync(out, git(['diff']))
      git(['checkout', '-q', '--', 'server.js'])
      return out
    })
  return { product, origin, baseSha, patches }
}

function capture(f: Fixture, patchPath: string): RunFixCapture {
  return {
    capturedAt: '2026-08-02T00:00:00.000Z',
    repos: [{ repoName: 'svc', repoRoot: f.product, baseSha: f.baseSha, patchPath, patchFile: path.basename(patchPath), files: 1 }],
  }
}

function preflight(f: Fixture): PrPreflight {
  return {
    gh: { installed: true, authed: true, account: 'proof' } as PrPreflight['gh'],
    anyPushable: true,
    repos: [{
      repoName: 'svc',
      repoRoot: f.product,
      origin: { owner: 'acme', name: 'svc', host: 'github.com' },
      base: 'main',
      pushable: true,
    }],
  }
}

/** gh stub: no PR exists yet, and `pr create` reports one. Records every call
 *  so the test can assert the draft flag actually reaches the CLI. */
function ghStub(calls: string[][]) {
  return async (args: string[]): Promise<GhResult> => {
    calls.push(args)
    if (args[1] === 'list') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: 'https://github.com/acme/svc/pull/1\n', stderr: '' }
  }
}

const originHead = (origin: string, branch: string): string =>
  execFileSync('git', ['--git-dir', origin, 'rev-parse', branch], { encoding: 'utf-8' }).trim()

describe('proposeFixesForRun against a real git remote', () => {
  it('pushes the fix branch to origin and opens a draft PR', async () => {
    const f = fixture()
    const calls: string[][] = []
    const results = await proposeFixesForRun({
      runId: 'r1', feature: 'checkout', fixCapture: capture(f, f.patches[0]), preflight: preflight(f),
      draft: true, deps: { gh: ghStub(calls) },
    })

    expect(results).toEqual([expect.objectContaining({ repoName: 'svc', ok: true })])
    // The branch really exists on the remote and carries the repair.
    expect(() => originHead(f.origin, BRANCH)).not.toThrow()
    const blob = execFileSync('git', ['--git-dir', f.origin, 'show', `${BRANCH}:server.js`], { encoding: 'utf-8' })
    expect(blob).toContain('process.env.PORT')
    expect(calls.find((c) => c[1] === 'create')).toContain('--draft')
    // The product repo's own checkout is untouched — that is the load-bearing promise.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: f.product, encoding: 'utf-8' }).trim()).toBe('')
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.product, encoding: 'utf-8' }).trim()).toBe(f.baseSha)
  })

  it('force-pushes a second repair onto the same branch from a clone that never fetched it', async () => {
    const f = fixture()
    await proposeFixesForRun({
      runId: 'r1', feature: 'checkout', fixCapture: capture(f, f.patches[0]), preflight: preflight(f),
      draft: true, deps: { gh: ghStub([]) },
    })
    const first = originHead(f.origin, BRANCH)

    // Drop the remote-tracking ref the first push left behind. That is what a
    // fresh clone, a pruned ref, or another machine's push looks like — and it
    // is the exact state in which `--force-with-lease` refuses as "stale info".
    await runGit(f.product, ['update-ref', '-d', `refs/remotes/origin/${BRANCH}`])

    const results = await proposeFixesForRun({
      runId: 'r2', feature: 'checkout', fixCapture: capture(f, f.patches[1]), preflight: preflight(f),
      draft: true, deps: { gh: ghStub([]) },
    })

    expect(results).toEqual([expect.objectContaining({ ok: true })])
    expect(originHead(f.origin, BRANCH)).not.toBe(first)
    expect(execFileSync('git', ['--git-dir', f.origin, 'show', `${BRANCH}:server.js`], { encoding: 'utf-8' }))
      .toContain('Number(process.env.PORT)')
  })

  it('without the pre-push fetch, that same second repair is rejected as stale info', async () => {
    const f = fixture()
    await proposeFixesForRun({
      runId: 'r1', feature: 'checkout', fixCapture: capture(f, f.patches[0]), preflight: preflight(f),
      draft: true, deps: { gh: ghStub([]) },
    })
    const first = originHead(f.origin, BRANCH)
    await runGit(f.product, ['update-ref', '-d', `refs/remotes/origin/${BRANCH}`])

    // Swallow only the fetch — everything else is real git. This is the control
    // arm: it shows the guard is load-bearing rather than incidental.
    const noFetch = async (cwd: string, args: string[]): Promise<GitResult> =>
      args[0] === 'fetch' ? { code: 0, stdout: '', stderr: '' } : runGit(cwd, args)

    const results = await proposeFixesForRun({
      runId: 'r2', feature: 'checkout', fixCapture: capture(f, f.patches[1]), preflight: preflight(f),
      draft: true, deps: { gh: ghStub([]), git: noFetch },
    })

    expect(results[0].ok).toBe(false)
    expect(results[0].reason).toMatch(/stale info/)
    // And the remote still holds the first repair — nothing was clobbered.
    expect(originHead(f.origin, BRANCH)).toBe(first)
  })
})
