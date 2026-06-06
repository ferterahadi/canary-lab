import { describe, it, expect } from 'vitest'
import { worktreeFeatureDir } from './worktree-feature-dir'

describe('worktreeFeatureDir', () => {
  it('maps a self-contained feature dir (featureDir === repo) into the worktree', () => {
    // Scaffold samples: localPath === featureDir === __dirname.
    expect(
      worktreeFeatureDir({
        repoLocalPath: '/ws/features/flaky_orders_api',
        featureDir: '/ws/features/flaky_orders_api',
        worktreeRepoPath: '/bench/worktrees/arm-A/flaky_orders_api',
      }),
    ).toBe('/bench/worktrees/arm-A/flaky_orders_api')
  })

  it('maps a feature dir nested inside the repo into the worktree, preserving the subpath', () => {
    expect(
      worktreeFeatureDir({
        repoLocalPath: '/ws/monorepo',
        featureDir: '/ws/monorepo/features/foo',
        worktreeRepoPath: '/bench/worktrees/arm-A/monorepo',
      }),
    ).toBe('/bench/worktrees/arm-A/monorepo/features/foo')
  })

  it('keeps an EXTERNAL feature dir canonical (harness lives outside the repo worktree)', () => {
    // The mighty-cns case: feature dir holds playwright.config + e2e; the repo
    // under test is a separate checkout. The harness is not in the worktree, so
    // Playwright must run from the canonical feature dir.
    expect(
      worktreeFeatureDir({
        repoLocalPath: '/Users/dev/Documents/mighty-cns',
        featureDir: '/Users/dev/Documents/canary-lab-workspace/features/cns_batch_queue_resilience',
        worktreeRepoPath: '/bench/worktrees/arm-A/mighty-cns',
      }),
    ).toBe('/Users/dev/Documents/canary-lab-workspace/features/cns_batch_queue_resilience')
  })

  it('treats a sibling sharing a path prefix as external (no false "inside repo")', () => {
    // `/a/b` is NOT inside `/a/bc` — relative() yields a `..` segment.
    expect(
      worktreeFeatureDir({
        repoLocalPath: '/a/b',
        featureDir: '/a/bc',
        worktreeRepoPath: '/wt/b',
      }),
    ).toBe('/a/bc')
  })
})
