import { describe, it, expect } from 'vitest'
import { detectGhStatus, detectRepoPushRights, parseGitHubRemote, type GhResult } from './gh-cli'

const ok = (stdout = '', stderr = ''): GhResult => ({ code: 0, stdout, stderr })
const fail = (stderr = '', code = 1): GhResult => ({ code, stdout: '', stderr })

function fakeRunner(map: Record<string, GhResult>): (args: string[]) => Promise<GhResult> {
  return async (args) => {
    const key = args.join(' ')
    for (const [prefix, res] of Object.entries(map)) {
      if (key.startsWith(prefix)) return res
    }
    return fail('unexpected: ' + key, 1)
  }
}

describe('parseGitHubRemote', () => {
  it('parses ssh and https github remotes', () => {
    expect(parseGitHubRemote('git@github.com:oddle-engineering/oddlefnb.git'))
      .toEqual({ host: 'github.com', owner: 'oddle-engineering', name: 'oddlefnb' })
    expect(parseGitHubRemote('https://github.com/oddle-engineering/oddle-merchant-pass'))
      .toEqual({ host: 'github.com', owner: 'oddle-engineering', name: 'oddle-merchant-pass' })
  })
  it('returns null for an unrecognized remote', () => {
    expect(parseGitHubRemote('file:///tmp/local-repo')).toBeNull()
  })
})

describe('detectGhStatus', () => {
  it('reports not-installed when gh --version fails', async () => {
    expect(await detectGhStatus(fakeRunner({ '--version': fail('', 127) })))
      .toEqual({ installed: false, authenticated: false })
  })
  it('reports installed-but-unauthenticated when auth status fails', async () => {
    expect(await detectGhStatus(fakeRunner({ '--version': ok('gh 2.0'), 'auth status': fail('not logged in') })))
      .toEqual({ installed: true, authenticated: false })
  })
  it('parses the account + host from auth status (newer phrasing)', async () => {
    const status = detectGhStatus(fakeRunner({
      '--version': ok('gh 2.62'),
      'auth status': ok('', 'github.com\n  ✓ Logged in to github.com account ferterahadi-oddle (keyring)\n  - Token: gho_****'),
    }))
    expect(await status).toEqual({ installed: true, authenticated: true, host: 'github.com', account: 'ferterahadi-oddle' })
  })
  it('parses the older "as <user>" phrasing', async () => {
    const status = await detectGhStatus(fakeRunner({
      '--version': ok('gh 2.0'),
      'auth status': ok('', '  ✓ Logged in to github.com as octocat (oauth_token)'),
    }))
    expect(status.account).toBe('octocat')
  })
})

describe('detectRepoPushRights', () => {
  it('true when the API reports permissions.push=true', async () => {
    const r = await detectRepoPushRights('o', 'r', fakeRunner({ 'api repos/o/r': ok('true\n') }))
    expect(r).toEqual({ pushable: true })
  })
  it('false + reason when the account cannot push (wrong account)', async () => {
    const r = await detectRepoPushRights('o', 'r', fakeRunner({ 'api repos/o/r': ok('false\n') }))
    expect(r).toEqual({ pushable: false })
  })
  it('false + reason when the repo is not accessible', async () => {
    const r = await detectRepoPushRights('o', 'r', fakeRunner({ 'api repos/o/r': fail('gh: Not Found (HTTP 404)') }))
    expect(r.pushable).toBe(false)
    expect(r.reason).toContain('Not Found')
  })

  it('reads the reason off stdout when gh failed without writing to stderr', async () => {
    const r = await detectRepoPushRights('o', 'r', async () => ({ code: 1, stdout: '  gh: Bad credentials\n', stderr: '' }))
    expect(r).toEqual({ pushable: false, reason: 'gh: Bad credentials' })
  })

  it('supplies its own reason when gh failed silently on both streams', async () => {
    const r = await detectRepoPushRights('o', 'r', async () => ({ code: 1, stdout: '', stderr: '' }))
    expect(r).toEqual({ pushable: false, reason: 'repo not accessible under the signed-in account' })
  })

  it('reports only the first non-blank line of a multi-line gh error', async () => {
    const r = await detectRepoPushRights('o', 'r', async () => ({
      code: 1,
      stdout: '',
      stderr: '\n\ngh: Not Found (HTTP 404)\nTry authenticating with: gh auth login\n',
    }))
    expect(r.reason).toBe('gh: Not Found (HTTP 404)')
  })
})
