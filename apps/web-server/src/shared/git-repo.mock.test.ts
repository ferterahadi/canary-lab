import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'

const tmpDir = trackTempDirs('cl-git-mock-')

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))

afterEach(() => {
  execFileMock.mockReset()
  vi.resetModules()
})

describe('git-repo subprocess edge cases', () => {
  it.each(['repository', 'directory'] as const)('inspects %s scope with one local status command and no path normalization', async (scope) => {
    mockGitSequence([{ stdout: ' M first\r\n?? second  \n\n' }])
    const { readWorkingTree } = await import('./git-repo')
    await expect(readWorkingTree('~/untouched-path', scope)).resolves.toEqual({ ok: true, lines: [' M first', '?? second'], stdout: ' M first\r\n?? second  \n\n' })
    expect(execFileMock).toHaveBeenCalledExactlyOnceWith('git',
      ['--no-optional-locks', 'status', '--porcelain', ...(scope === 'directory' ? ['--', '.'] : [])],
      { cwd: '~/untouched-path' }, expect.any(Function))
  })

  it('preserves a failed status command exit code and both diagnostic streams', async () => {
    const result = { code: 128, stdout: 'partial output\n', stderr: 'fatal: broken index\n' }
    mockGitSequence([result])
    const { readWorkingTree } = await import('./git-repo')
    await expect(readWorkingTree('/repo', 'directory')).resolves.toEqual({ ok: false, result })
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('preserves subprocess spawn failures as failed inspections', async () => {
    execFileMock.mockImplementationOnce(() => ({
      on: (_event: string, callback: (error: Error) => void) => callback(new Error('spawn ENOENT')),
    }))
    const { readWorkingTree } = await import('./git-repo')
    await expect(readWorkingTree('/missing', 'directory')).resolves.toEqual({
      ok: false, result: { code: 1, stdout: '', stderr: 'spawn ENOENT' },
    })
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [1, 'branch --show-current'],
    [2, 'rev-parse --verify --quiet HEAD'],
    [3, 'status --porcelain'],
    [4, 'for-each-ref refs/heads'],
    [5, 'for-each-ref refs/remotes'],
  ] as const)('rejects failed required read %s before checkout or merge', async (position, command) => {
    const repo = tmpDir()
    const results = successfulStatus()
    results[position] = { code: 128, stderr: 'broken repository\n' }
    const { checkoutBranch } = await import('./git-repo')
    const { fastForwardToUpstream } = await import('./git-upstream')
    for (const mutate of [() => checkoutBranch(repo, 'other'), () => fastForwardToUpstream(repo)]) {
      mockGitSequence([...results])
      await expect(mutate()).rejects.toMatchObject({
        statusCode: 500,
        message: `Unable to read Git status (${command}): broken repository`,
      })
    }
    expect(execFileMock.mock.calls.some((call) => ['checkout', 'merge', 'fetch'].includes(call[1][0]))).toBe(false)
  })

  it.each([
    { stdout: 'diagnostic\n', stderr: '', expected: 'diagnostic' },
    { stdout: ' \n', stderr: ' \n', expected: 'git command failed' },
  ])('uses the required-read diagnostic fallback $expected', async ({ stdout, stderr, expected }) => {
    const results = successfulStatus()
    results[3] = { code: 128, stdout, stderr }
    mockGitSequence(results)
    const { getGitStatus } = await import('./git-repo')
    await expect(getGitStatus(tmpDir())).rejects.toThrow(`Unable to read Git status (status --porcelain): ${expected}`)
  })

  it.each([
    { code: 1, stdout: '', stderr: 'spawn failed' },
    { code: 1, stdout: 'unexpected output', stderr: '' },
  ])('does not confuse HEAD failure $stderr$stdout with an unborn branch', async (failure) => {
    const results = successfulStatus()
    results[2] = failure
    mockGitSequence(results)
    const { getGitStatus } = await import('./git-repo')
    await expect(getGitStatus(tmpDir())).rejects.toMatchObject({ statusCode: 500 })
  })

  it('announces a successful checkout once after a failed follow-up read', async () => {
    const afterCheckout = successfulStatus()
    afterCheckout[3] = { code: 128, stderr: 'index became unreadable' }
    mockGitSequence([...successfulStatus(), { stdout: '' }, ...afterCheckout])
    const { checkoutBranch } = await import('./git-repo')
    const publish = vi.fn()
    await expect(checkoutBranch(tmpDir(), 'other', { publish })).rejects.toThrow('index became unreadable')
    expect(publish).toHaveBeenCalledExactlyOnceWith({ type: 'features-changed' })
    expect(execFileMock.mock.calls.filter((call) => call[1][0] === 'checkout')).toHaveLength(1)
  })

  it('returns null when git reports a blank working-tree root', async () => {
    const repo = tmpDir()
    mockGitSequence([{ stdout: '\n' }])
    const { getGitRoot } = await import('./git-repo')

    await expect(getGitRoot(repo)).resolves.toBeNull()
  })

  it('returns empty status when git reports a nonnumeric process error', async () => {
    const repo = tmpDir()
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), '', 'spawn failed')
      return fakeChild()
    })
    const { getGitStatus } = await import('./git-repo')

    await expect(getGitStatus(repo)).resolves.toMatchObject({ isGitRepo: false })
  })

  it('surfaces default checkout failure text when git emits no output', async () => {
    const repo = tmpDir()
    // One reply per subprocess getGitStatus spawns — is-inside-work-tree, then
    // the branch / HEAD sha / porcelain status / local refs / remote refs
    // quintet — followed by the checkout itself.
    mockGitSequence([
      { stdout: 'true\n' },
      { stdout: 'main\n' },
      { stdout: `${'a'.repeat(40)}\n` },
      { stdout: '' },
      { stdout: 'main\n' },
      { stdout: '' },
      { code: 1, stdout: '', stderr: '' },
    ])
    const { checkoutBranch } = await import('./git-repo')

    await expect(checkoutBranch(repo, 'feature/missing')).rejects.toMatchObject({
      message: 'git checkout failed',
      statusCode: 500,
    })
  })

  it('resolves with stderr from child.on(error) when spawn itself fails', async () => {
    const repo = tmpDir()
    execFileMock.mockImplementationOnce(() => {
      // Don't invoke the execFile callback — only trigger the error event.
      return {
        on: (event: string, cb: (err: Error) => void) => {
          if (event === 'error') cb(new Error('spawn ENOENT'))
        },
      }
    })
    const { getGitStatus } = await import('./git-repo')
    await expect(getGitStatus(repo)).resolves.toMatchObject({ isGitRepo: false })
  })

  it('reports a branch mismatch when current branch differs from expected', async () => {
    const repo = tmpDir()
    mockGitSequence([
      { stdout: 'true\n' },
      { stdout: 'dev\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const { validateConfiguredRepoBranches } = await import('./git-repo')
    await expect(validateConfiguredRepoBranches({
      name: 'demo',
      description: 'd',
      envs: [],
      featureDir: repo,
      repos: [{ name: 'app', localPath: repo, branch: 'main' }],
    })).rejects.toThrow('app: expected main, current dev')
  })

  it('validates configured repo branches without failures when they match', async () => {
    const repo = tmpDir()
    mockGitSequence([
      { stdout: 'true\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const { validateConfiguredRepoBranches } = await import('./git-repo')
    await expect(validateConfiguredRepoBranches({
      name: 'demo',
      description: 'd',
      envs: [],
      featureDir: repo,
      repos: [{ name: 'app', localPath: repo, branch: 'main' }],
    })).resolves.toBeUndefined()
  })

  it('handles empty repo lists and branch checks with no current branch', async () => {
    const repo = tmpDir()
    mockGitSequence([
      { stdout: 'true\n' },
      { stdout: '\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const { collectRepoBranchSnapshots, validateConfiguredRepoBranches } = await import('./git-repo')

    await expect(collectRepoBranchSnapshots({ name: 'demo', description: 'd', envs: [], featureDir: repo })).resolves.toEqual([])
    await expect(validateConfiguredRepoBranches({
      name: 'demo',
      description: 'd',
      envs: [],
      featureDir: repo,
      repos: [{ name: 'app', localPath: repo, branch: 'main' }],
    })).rejects.toThrow('app: expected main, but checkout is detached')
  })
})

function successfulStatus(): Array<{ code?: number; stdout?: string; stderr?: string }> {
  return [{ stdout: 'true\n' }, { stdout: 'main\n' }, { stdout: `${'a'.repeat(40)}\n` }, {}, { stdout: 'main\n' }, {}]
}

function mockGitSequence(results: Array<{ code?: number; stdout?: string; stderr?: string }>): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    const next = results.shift() ?? {}
    const code = next.code ?? 0
    cb(code === 0 ? null : Object.assign(new Error('git failed'), { code }), next.stdout ?? '', next.stderr ?? '')
    return fakeChild()
  })
}

function fakeChild(): { on: (event: string, cb: (err: Error) => void) => void } {
  return { on: vi.fn() }
}
