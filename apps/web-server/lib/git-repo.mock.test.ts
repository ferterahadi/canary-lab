import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))

afterEach(() => {
  execFileMock.mockReset()
  vi.resetModules()
})

describe('git-repo subprocess edge cases', () => {
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
    mockGitSequence([
      { stdout: 'true\n' },
      { stdout: 'main\n' },
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

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-git-mock-')))
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
