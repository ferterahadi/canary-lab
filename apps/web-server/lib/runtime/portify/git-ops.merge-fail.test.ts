import { describe, expect, it, vi } from 'vitest'

// Isolate the branch in mergePortifyBranch where git merge fails but produces
// no unmerged files (line 152: throw when conflictFiles is empty). A real
// non-conflict merge failure is hard to force deterministically, so we mock.
vi.mock('../../git-repo', () => ({
  runGit: vi.fn(async (_cwd: string, args: string[]) => {
    // mergeStatus calls:
    if (args.includes('rev-parse') && args.includes('-q') && args.includes('--verify') && args.some((a) => a.startsWith('refs/heads/'))) {
      return { code: 0, stdout: 'abc123\n', stderr: '' } // branch exists
    }
    if (args.includes('symbolic-ref')) {
      return { code: 0, stdout: 'main\n', stderr: '' } // not detached
    }
    if (args.includes('status') && args.includes('--porcelain')) {
      return { code: 0, stdout: '', stderr: '' } // clean
    }
    if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) {
      return { code: 1, stdout: '', stderr: '' } // no merge in progress
    }
    if (args.includes('merge-base') && args.includes('--is-ancestor')) {
      return { code: 1, stdout: '', stderr: '' } // not already merged
    }
    // The actual merge attempt — fail with no conflict output
    if (args.includes('merge') && !args.includes('--abort')) {
      return { code: 1, stdout: '', stderr: 'merge failed for unrelated reason' }
    }
    // diff --name-only --diff-filter=U: no conflicted files
    if (args.includes('diff') && args.includes('--diff-filter=U')) {
      return { code: 0, stdout: '', stderr: '' }
    }
    // merge --abort
    if (args.includes('merge') && args.includes('--abort')) {
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }),
}))

const { mergePortifyBranch } = await import('./git-ops')

describe('mergePortifyBranch — merge failure with no conflict files', () => {
  it('throws with the merge stderr when the merge fails and no conflict files are listed', async () => {
    await expect(mergePortifyBranch('/repo', 'canary/dynamic-ports-f')).rejects.toThrow(
      /merge failed: merge failed for unrelated reason/,
    )
  })
})
