import { beforeEach, expect, it, vi } from 'vitest'
import type { GitStatus } from './git-repo'

const git = vi.hoisted(() => ({ getGitStatus: vi.fn(), runGit: vi.fn() }))
vi.mock('./git-repo', async (original) => ({
  ...await original<typeof import('./git-repo')>(),
  ...git,
}))
import { describeRepoCheckout, getUpstreamStatus } from './git-upstream'

const status: GitStatus = {
  isGitRepo: true, currentBranch: 'main', headSha: 'head', detached: false,
  dirty: false, dirtyFiles: [], localBranches: ['main', 'pinned'], remoteBranches: [],
}
beforeEach(() => {
  git.getGitStatus.mockReset().mockResolvedValue(status)
  git.runGit.mockReset().mockImplementation(async (_cwd, args: string[]) => ({
    code: args.includes('--symbolic-full-name') ? 1 : 0,
    stdout: args.includes('--symbolic-full-name') ? '' : 'sha\n', stderr: '',
  }))
})

it.each(['standalone', 'checkout'] as const)('reads status once for the %s upstream response', async (reader) => {
  const result = reader === 'standalone'
    ? await getUpstreamStatus('/repo')
    : await describeRepoCheckout({ name: 'app', localPath: '/repo', branch: 'pinned' })
  expect(result).toMatchObject({ branch: reader === 'standalone' ? 'main' : 'pinned', branchSha: 'sha', upstream: null })
  expect(git.getGitStatus).toHaveBeenCalledExactlyOnceWith('/repo')
  expect(git.runGit.mock.calls.some((call) => call[1][0] === 'fetch')).toBe(false)
  if (reader === 'checkout') expect(result).toMatchObject({ currentBranch: 'main', headSha: 'head', expectedBranch: 'pinned' })
})

it('does not reread or inspect upstream after the single status read fails', async () => {
  git.getGitStatus.mockRejectedValue(new Error('unreadable status'))
  await expect(describeRepoCheckout({ name: 'app', localPath: '/repo' })).rejects.toThrow('unreadable status')
  expect(git.getGitStatus).toHaveBeenCalledTimes(1)
  expect(git.runGit).not.toHaveBeenCalled()
})
