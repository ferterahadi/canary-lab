import { describe, it, expect } from 'vitest'
import { buildPrPreflight, type PrPreflightDeps } from './pr-preflight'
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
})
