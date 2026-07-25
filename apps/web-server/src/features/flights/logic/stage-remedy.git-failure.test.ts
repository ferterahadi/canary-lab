import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightManifest } from '../../../../../../shared/flights/types'

// A real repo can be made to fail `git commit` (no identity), but not to fail
// with an empty stderr — and the reason line has a stdout fallback for exactly
// that case. Faking the runner is the only way to pin both arms.
const gitMocks = vi.hoisted(() => ({ runGit: vi.fn() }))
vi.mock('../../../shared/git-repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/git-repo')>()),
  runGit: gitMocks.runGit,
}))

const { applyFlightStageRemedy } = await import('./stage-remedy')

const DIRTY_ERROR = 'portify start rejected (409): repos "a" have uncommitted changes — commit or stash them first'

function manifest(): FlightManifest {
  return {
    flightId: 'fl_test', feature: 'feat', repoPaths: ['/repos/a'], description: 'd',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'paused', pauseReason: 'stage-failed', currentStage: 'portify',
    stages: [{ key: 'portify', status: 'failed', error: DIRTY_ERROR }],
    createdAt: 'now', updatedAt: 'now',
  } as FlightManifest
}

/** `git status` always reports one modified file; the mutation reports `failure`. */
function gitFailingWith(failure: { code: number; stdout: string; stderr: string }): void {
  gitMocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
    if (args[0] === 'status') return { code: 0, stdout: ' M f.txt\n', stderr: '' }
    return failure
  })
}

beforeEach(() => {
  gitMocks.runGit.mockReset()
})

describe('applyFlightStageRemedy — a failing git command', () => {
  it('throws a 500 naming the repo and the git stderr', async () => {
    gitFailingWith({ code: 1, stdout: '', stderr: 'fatal: could not read Username\n' })
    await expect(applyFlightStageRemedy(manifest(), 'stash')).rejects.toMatchObject({
      statusCode: 500,
      message: 'git stash failed in "a": fatal: could not read Username',
    })
  })

  it('falls back to stdout when git failed without writing to stderr', async () => {
    gitFailingWith({ code: 1, stdout: 'nothing to commit\n', stderr: '' })
    await expect(applyFlightStageRemedy(manifest(), 'commit')).rejects.toMatchObject({
      statusCode: 500,
      message: 'git add failed in "a": nothing to commit',
    })
  })
})
