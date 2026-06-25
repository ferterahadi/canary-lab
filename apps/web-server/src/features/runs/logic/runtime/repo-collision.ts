import path from 'path'
import { resolveRepoPath } from '../../../../shared/git-repo'

/**
 * Same-repo collision detection. Two concurrent runs that edit the same repo
 * working tree (e.g. two runs of the same feature) would corrupt each other —
 * the heal loop edits code in place. Different apps point at different
 * `localPath`s, so they never collide and run in place with no worktree.
 *
 * This module is pure: given the repo paths a candidate run needs and the repo
 * paths of currently-active runs, it reports the first overlap. The caller
 * decides what to do (prompt for worktree isolation vs queue).
 */

export interface ActiveRunRepos {
  runId: string
  feature: string
  /** Resolved or raw repo paths the active run occupies (manifest.repoPaths). */
  repoPaths: string[]
}

export interface RepoCollision {
  conflictingRunId: string
  conflictingFeature: string
  /** The overlapping resolved repo paths. */
  repoPaths: string[]
}

/** Resolve `~`, make absolute, and dedupe a set of repo paths. */
export function normalizeRepoPaths(paths: Iterable<string> | undefined): string[] {
  const out = new Set<string>()
  for (const p of paths ?? []) {
    if (typeof p !== 'string' || p.length === 0) continue
    out.add(path.resolve(resolveRepoPath(p)))
  }
  return [...out]
}

/**
 * Return the first active run whose repo paths overlap the candidate's, or
 * null when there is no collision. An empty candidate set never collides.
 */
export function detectRepoCollision(
  candidateRepoPaths: string[] | undefined,
  activeRuns: ActiveRunRepos[],
): RepoCollision | null {
  const candidate = new Set(normalizeRepoPaths(candidateRepoPaths))
  if (candidate.size === 0) return null
  for (const run of activeRuns) {
    const overlap = normalizeRepoPaths(run.repoPaths).filter((p) => candidate.has(p))
    if (overlap.length > 0) {
      return {
        conflictingRunId: run.runId,
        conflictingFeature: run.feature,
        repoPaths: overlap,
      }
    }
  }
  return null
}
