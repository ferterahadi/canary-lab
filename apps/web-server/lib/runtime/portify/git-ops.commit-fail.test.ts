import { describe, expect, it, vi } from 'vitest'

// Isolate commitWorktree's failure branch by stubbing git: staged changes are
// present but `git commit` exits non-zero. (A real commit failure is hard to
// force deterministically, so we mock the git layer for this one path.)
vi.mock('../../git-repo', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runGit: vi.fn(async (_cwd: string, args: string[]) => {
    if (args.includes('commit')) return { code: 1, stdout: '', stderr: 'boom' }
    if (args.includes('diff') && args.includes('--cached')) return { code: 0, stdout: 'app.js\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }),
  snapshotWorkingTree: vi.fn(async () => 'HEAD'),
  diffContentSinceSnapshot: vi.fn(async () => ''),
}))

const { commitWorktree } = await import('./git-ops')

describe('commitWorktree failure', () => {
  it('throws with the git stderr when the commit exits non-zero', async () => {
    await expect(commitWorktree('/wt', 'feat: ports')).rejects.toThrow(/commit failed: boom/)
  })
})
