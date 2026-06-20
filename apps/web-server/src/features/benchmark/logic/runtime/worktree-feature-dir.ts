import path from 'path'

/**
 * Resolve where a feature's test harness (its `playwright.config.*` + `e2e/`)
 * lives once the benchmarked repo has been checked out into a git worktree.
 *
 * The benchmark worktrees the *repo* the agent edits and boots services from
 * it. Two feature layouts exist:
 *
 *  - **Self-contained** (the scaffold samples): `featureDir === repo.localPath`
 *    — the playwright config, e2e specs, and service source all live in one
 *    directory that *is* the repo. Worktreeing the repo brings the harness
 *    along, so the feature dir maps into the worktree.
 *
 *  - **External** (e.g. `mighty-cns`): `featureDir` is a separate directory
 *    that merely points `repos[].localPath` at another checkout. The harness is
 *    NOT inside the repo, so it is never part of the worktree — the canonical
 *    feature dir must be kept, exactly as a non-benchmark `canary-lab run` uses
 *    it. (Mapping it into the worktree was the bug: Playwright found no config
 *    there and globbed the repo's own unit `*.spec.ts` instead of the feature's
 *    e2e suite.)
 *
 * The discriminator is purely positional: is `featureDir` inside `repoLocalPath`?
 * All inputs are absolute and already `resolveRepoPath`-resolved.
 *
 * @param worktreeRepoPath `WorktreeHandle.localPath` — the repo remapped into
 *   the worktree (subpath preserved for repos nested under a larger git root).
 */
export function worktreeFeatureDir(opts: {
  repoLocalPath: string
  featureDir: string
  worktreeRepoPath: string
}): string {
  const rel = path.relative(opts.repoLocalPath, opts.featureDir)
  const insideRepo = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  return insideRepo ? path.join(opts.worktreeRepoPath, rel) : opts.featureDir
}
