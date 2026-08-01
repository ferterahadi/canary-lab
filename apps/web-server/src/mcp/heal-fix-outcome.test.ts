import { describe, it, expect } from 'vitest'
import { healFixOutcome } from './heal-task-wait'
import type { RunDetail } from '../features/runs/logic/run-store'

// The `passed` result is the only thing a skill-less external agent reads once
// its repair lands. If it doesn't say a pull request already exists, the agent
// reasonably opens one of its own — which is a second push nobody asked for.

function detail(manifest: Partial<RunDetail['manifest']>): RunDetail {
  return {
    runId: 'r1',
    manifest: { runId: 'r1', feature: 'fnb', startedAt: 'now', status: 'passed', healCycles: 1, services: [], ...manifest },
  } as RunDetail
}

describe('healFixOutcome', () => {
  it('is absent when the run changed no code', () => {
    expect(healFixOutcome(detail({}))).toBeUndefined()
    expect(healFixOutcome(detail({ fixCapture: { capturedAt: 'now', repos: [] } }))).toBeUndefined()
  })

  it('reports the PR url per repo and tells the agent not to open another', () => {
    const out = healFixOutcome(detail({
      fixCapture: { capturedAt: 'now', repos: [{ repoName: 'fnb', patchPath: '/p', patchFile: 'p', repoRoot: '/r', baseSha: 'a', files: 4 }] },
      proposedPrs: [{ repoName: 'fnb', url: 'https://gh/pr/1', branch: 'b', base: 'main', createdAt: 'T' }],
    }))
    expect(out?.repos).toEqual([{ repoName: 'fnb', files: 4, pr: 'https://gh/pr/1' }])
    expect(out?.note).toMatch(/do NOT open or push one yourself/i)
  })

  it('reports why a repo has no PR instead of leaving the agent guessing', () => {
    const out = healFixOutcome(detail({
      fixCapture: { capturedAt: 'now', repos: [{ repoName: 'fnb', patchPath: '/p', patchFile: 'p', repoRoot: '/r', baseSha: 'a', files: 1 }] },
      prAttempt: { at: 'T', auto: true, results: [{ repoName: 'fnb', ok: false, reason: 'gh is not signed in' }] },
    }))
    expect(out?.repos).toEqual([{ repoName: 'fnb', files: 1, noPrReason: 'gh is not signed in' }])
  })

  it('covers every changed repo, including one that neither opened nor failed', () => {
    const out = healFixOutcome(detail({
      fixCapture: {
        capturedAt: 'now',
        repos: [
          { repoName: 'api', patchPath: '/a', patchFile: 'a', repoRoot: '/r1', baseSha: 'a', files: 2 },
          { repoName: 'web', patchPath: '/w', patchFile: 'w', repoRoot: '/r2', baseSha: 'b', files: 5 },
        ],
      },
      proposedPrs: [{ repoName: 'api', url: 'https://gh/pr/2', branch: 'b', base: 'main', createdAt: 'T' }],
    }))
    expect(out?.repos.map((r) => r.repoName)).toEqual(['api', 'web'])
    expect(out?.repos[1]).toEqual({ repoName: 'web', files: 5 })
  })
})
