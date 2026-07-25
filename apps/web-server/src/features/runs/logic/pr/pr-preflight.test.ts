import { afterEach, describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Only the two `gh` probes are faked; `parseGitHubRemote` stays real because
// preflight's github-ness check is part of what these tests assert.
const ghMocks = vi.hoisted(() => ({
  detectGhStatus: vi.fn(async () => ({ installed: true, authenticated: true, account: 'default-account', host: 'github.com' })),
  detectRepoPushRights: vi.fn(async () => ({ pushable: true })),
}))
vi.mock('../../../../shared/gh-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/gh-cli')>()),
  detectGhStatus: ghMocks.detectGhStatus,
  detectRepoPushRights: ghMocks.detectRepoPushRights,
}))

const { buildPrPreflight } = await import('./pr-preflight')
type PrPreflightDeps = import('./pr-preflight').PrPreflightDeps
import type { RunFixCapture } from '../../../../../../../shared/run-state'
import type { GhStatus } from '../../../../shared/gh-cli'

const fixCapture: RunFixCapture = {
  capturedAt: 'now',
  repos: [{ repoName: 'fnb', patchPath: '/r/fixes/fnb.patch', patchFile: 'fnb.patch', repoRoot: '/repos/fnb', baseSha: 'abc', files: 2 }],
}

const connected: GhStatus = { installed: true, authenticated: true, account: 'ferterahadi-oddle', host: 'github.com' }

function deps(over: Partial<PrPreflightDeps> = {}): PrPreflightDeps {
  return {
    ghStatus: async () => connected,
    pushRights: async () => ({ pushable: true }),
    originUrl: () => 'git@github.com:oddle-engineering/oddlefnb.git',
    baseBranch: () => 'development',
    ...over,
  }
}

describe('buildPrPreflight', () => {
  it('pushable when gh is connected and the account can push', async () => {
    const pre = await buildPrPreflight(fixCapture, deps())
    expect(pre.anyPushable).toBe(true)
    expect(pre.repos[0]).toMatchObject({
      repoName: 'fnb',
      pushable: true,
      base: 'development',
      origin: { owner: 'oddle-engineering', name: 'oddlefnb', host: 'github.com' },
    })
    expect(pre.repos[0].blocked).toBeUndefined()
  })

  it('blocks no-origin when the repo has no origin remote', async () => {
    const pre = await buildPrPreflight(fixCapture, deps({ originUrl: () => null }))
    expect(pre.anyPushable).toBe(false)
    expect(pre.repos[0].blocked?.reason).toBe('no-origin')
  })

  it('blocks not-github for a non-github remote', async () => {
    const pre = await buildPrPreflight(fixCapture, deps({ originUrl: () => 'https://gitlab.com/a/b.git' }))
    expect(pre.repos[0].blocked?.reason).toBe('not-github')
  })

  it('blocks gh-missing / not-authed off gh status', async () => {
    const missing = await buildPrPreflight(fixCapture, deps({ ghStatus: async () => ({ installed: false, authenticated: false }) }))
    expect(missing.repos[0].blocked?.reason).toBe('gh-missing')
    const unauth = await buildPrPreflight(fixCapture, deps({ ghStatus: async () => ({ installed: true, authenticated: false }) }))
    expect(unauth.repos[0].blocked?.reason).toBe('not-authed')
  })

  it('blocks wrong-account when signed in but cannot push, naming the account', async () => {
    const pre = await buildPrPreflight(fixCapture, deps({ pushRights: async () => ({ pushable: false }) }))
    expect(pre.repos[0].pushable).toBe(false)
    expect(pre.repos[0].blocked?.reason).toBe('wrong-account')
    expect(pre.repos[0].blocked?.detail).toContain('ferterahadi-oddle')
  })

  it('prefers the push-rights reason, and omits detail when neither it nor an account is known', async () => {
    const withReason = await buildPrPreflight(fixCapture, deps({
      pushRights: async () => ({ pushable: false, reason: 'repository is archived' }),
    }))
    expect(withReason.repos[0].blocked).toEqual({ reason: 'wrong-account', detail: 'repository is archived' })

    const anonymous = await buildPrPreflight(fixCapture, deps({
      ghStatus: async () => ({ installed: true, authenticated: true, host: 'github.com' }),
      pushRights: async () => ({ pushable: false }),
    }))
    expect(anonymous.repos[0].blocked).toEqual({ reason: 'wrong-account', detail: undefined })
  })
})

// The origin/base probes run against a real repo when the caller injects
// nothing — that's what the PR dialog does, so the defaults get real git.
describe('buildPrPreflight — uninjected git probes', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
  })

  function tmpRepo(originUrl?: string): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-preflight-')))
    roots.push(root)
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' })
    git(['config', 'user.email', 't@t.dev'])
    git(['config', 'user.name', 'test'])
    fs.writeFileSync(path.join(root, 'README.md'), '# x\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    if (originUrl !== undefined) git(['remote', 'add', 'origin', originUrl])
    return root
  }

  function captureFor(root: string): RunFixCapture {
    return { capturedAt: 'now', repos: [{ repoName: 'fnb', patchPath: '/p.patch', patchFile: 'p.patch', repoRoot: root, baseSha: 'abc', files: 1 }] }
  }

  const ghDeps = { ghStatus: async () => connected, pushRights: async () => ({ pushable: true }) }

  it('reads origin and the base branch straight off the repo', async () => {
    const root = tmpRepo('git@github.com:oddle-engineering/oddlefnb.git')
    const pre = await buildPrPreflight(captureFor(root), ghDeps)
    expect(pre.repos[0].origin).toEqual({ owner: 'oddle-engineering', name: 'oddlefnb', host: 'github.com' })
    expect(pre.repos[0].base).toBe('main')
    expect(pre.anyPushable).toBe(true)
  })

  it('blocks no-origin when git has no remote.origin.url (config exits non-zero)', async () => {
    const pre = await buildPrPreflight(captureFor(tmpRepo()), ghDeps)
    expect(pre.repos[0].origin).toBeNull()
    expect(pre.repos[0].blocked?.reason).toBe('no-origin')
  })

  it('blocks no-origin when remote.origin.url is configured but empty', async () => {
    const pre = await buildPrPreflight(captureFor(tmpRepo('')), ghDeps)
    expect(pre.repos[0].blocked?.reason).toBe('no-origin')
  })

  it('defaults to the shared gh detectors when the caller injects nothing', async () => {
    // The dialog calls buildPrPreflight bare, so the defaults are the wiring
    // under test here — not just unused fallbacks.
    ghMocks.detectGhStatus.mockClear()
    ghMocks.detectRepoPushRights.mockClear()
    const root = tmpRepo('git@github.com:oddle-engineering/oddlefnb.git')

    const pre = await buildPrPreflight(captureFor(root))

    expect(ghMocks.detectGhStatus).toHaveBeenCalledTimes(1)
    expect(ghMocks.detectRepoPushRights).toHaveBeenCalledWith('oddle-engineering', 'oddlefnb')
    expect(pre.gh.account).toBe('default-account')
    expect(pre.anyPushable).toBe(true)
  })
})
