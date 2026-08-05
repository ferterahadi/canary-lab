import { describe, it, expect } from 'vitest'
import { worktreeFeatureDir } from './worktree-feature-dir'

describe('worktreeFeatureDir', () => {
  it('maps a self-contained feature dir (featureDir === repo) into the worktree', () => {
    // A hand-written feature whose localPath === featureDir === __dirname. The
    // public scaffold starts with no features, so this stays a generic fixture.
    expect(
      worktreeFeatureDir({
        repoLocalPath: '/ws/features/sample_feature',
        featureDir: '/ws/features/sample_feature',
        worktreeRepoPath: '/bench/worktrees/arm-A/sample_feature',
      }),
    ).toBe('/bench/worktrees/arm-A/sample_feature')
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
    // The my-backend case: feature dir holds playwright.config + e2e; the repo
    // under test is a separate checkout. The harness is not in the worktree, so
    // Playwright must run from the canonical feature dir.
    expect(
      worktreeFeatureDir({
        repoLocalPath: '/Users/dev/Documents/my-backend',
        featureDir: '/Users/dev/Documents/canary-lab-workspace/features/cns_batch_queue_resilience',
        worktreeRepoPath: '/bench/worktrees/arm-A/my-backend',
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
