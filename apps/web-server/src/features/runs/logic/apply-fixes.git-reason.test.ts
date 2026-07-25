import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunFixCapture } from '../../../../../../shared/run-state'

// Real git always writes *something* to stderr when `apply` fails, so the
// stdout fallback and the generic last resort can only be pinned with a faked
// runner. The happy paths run against real repos in apply-fixes.test.ts.
const gitMocks = vi.hoisted(() => ({ runGit: vi.fn() }))
vi.mock('../../../shared/git-repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/git-repo')>()),
  runGit: gitMocks.runGit,
}))

const { applyFixCapture } = await import('./apply-fixes')

let root: string
let patchPath: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apply-fix-reason-')))
  patchPath = path.join(root, 'repo.patch')
  fs.writeFileSync(patchPath, 'diff --git a/x b/x\n')
  gitMocks.runGit.mockReset()
})

function capture(): RunFixCapture {
  return {
    capturedAt: 'now',
    repos: [{ repoName: 'repo', patchPath, patchFile: 'repo.patch', repoRoot: root, baseSha: 'deadbeef', files: 1 }],
  }
}

describe('applyFixCapture — where the failure reason comes from', () => {
  it('uses stdout when git failed without writing to stderr', async () => {
    gitMocks.runGit.mockResolvedValue({ code: 1, stdout: 'error: patch does not apply\n', stderr: '' })
    const out = await applyFixCapture(capture())
    expect(out.results[0]).toEqual({ repoName: 'repo', ok: false, reason: 'error: patch does not apply' })
  })

  it('falls back to a generic reason when git failed silently on both streams', async () => {
    gitMocks.runGit.mockResolvedValue({ code: 1, stdout: '  \n', stderr: '' })
    const out = await applyFixCapture(capture())
    expect(out.results[0]).toEqual({
      repoName: 'repo',
      ok: false,
      reason: 'git apply failed (the repo may have moved since the run)',
    })
  })
})
