import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The WIP hydration degrades rather than aborting: a patch that will not apply
// (or a scratch file that cannot be written) is reported and the run continues
// against HEAD. Real git can't be made to fail with an empty stderr, and the
// scratch-write failure needs a broken tmpdir — so the runner is faked here.
// The happy paths run against real repos in repo-worktree.test.ts.
const gitMocks = vi.hoisted(() => ({ runGit: vi.fn() }))
vi.mock('../../../../shared/git-repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/git-repo')>()),
  runGit: gitMocks.runGit,
}))

const { hydrateWorkingTreeDiff } = await import('./repo-worktree')

const WIP_DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
let handle: { sourceRoot: string; worktreeRoot: string }

/** `git diff HEAD` yields a WIP patch; `git apply` reports `applyResult`. */
function gitWithApply(applyResult: { code: number; stdout: string; stderr: string }): void {
  gitMocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
    if (args[0] === 'diff') return { code: 0, stdout: WIP_DIFF, stderr: '' }
    if (args[0] === 'apply') return applyResult
    return { code: 0, stdout: '', stderr: '' } // ls-files: nothing untracked
  })
}

beforeEach(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-wip-')))
  handle = { sourceRoot: path.join(root, 'src'), worktreeRoot: path.join(root, 'wt') }
  fs.mkdirSync(handle.sourceRoot, { recursive: true })
  fs.mkdirSync(handle.worktreeRoot, { recursive: true })
  gitMocks.runGit.mockReset()
})

describe('hydrateWorkingTreeDiff — a WIP patch that will not apply', () => {
  it('reports git stderr and leaves trackedApplied false', async () => {
    gitWithApply({ code: 1, stdout: '', stderr: 'error: patch failed: x:1\n' })
    await expect(hydrateWorkingTreeDiff(handle)).resolves.toEqual({
      trackedApplied: false,
      untrackedCopied: 0,
      error: 'error: patch failed: x:1',
    })
  })

  it('falls back to stdout, then to a generic reason, when git says nothing on stderr', async () => {
    gitWithApply({ code: 1, stdout: 'error: while searching for x\n', stderr: '' })
    expect((await hydrateWorkingTreeDiff(handle)).error).toBe('error: while searching for x')

    gitWithApply({ code: 1, stdout: '', stderr: '  ' })
    expect((await hydrateWorkingTreeDiff(handle)).error).toBe('git apply failed')
  })

  it('copies nothing when the untracked listing itself fails', async () => {
    gitMocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === 'diff') return { code: 0, stdout: '', stderr: '' }
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
    })
    await expect(hydrateWorkingTreeDiff(handle)).resolves.toEqual({ trackedApplied: false, untrackedCopied: 0 })
  })

  it('reports a scratch-patch write failure instead of throwing', async () => {
    gitWithApply({ code: 0, stdout: '', stderr: '' })
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    try {
      await expect(hydrateWorkingTreeDiff(handle)).resolves.toMatchObject({
        trackedApplied: false,
        error: 'ENOSPC: no space left on device',
      })
    } finally {
      spy.mockRestore()
    }
  })
})
