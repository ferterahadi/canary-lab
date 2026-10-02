import { resolveRepoIdentity } from '../../../../shared/repo-identity'

/**
 * Same-repo collision detection. Two concurrent runs that edit the same repo
 * working tree (e.g. two runs of the same feature) would corrupt each other —
 * the heal loop can edit code in place. Different physical directories remain
 * independent, including sibling subdirectories of one Git root.
 *
 * Resolve current filesystem identity for candidate and occupied paths, including
 * historical manifests that recorded a symlink. The caller decides what to do
 * with the first overlap (prompt for worktree isolation vs queue).
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

/** Dedupe physical directories, retaining absolute spellings for unavailable paths. */
export function normalizeRepoPaths(paths: Iterable<string> | undefined): string[] {
  const out = new Set<string>()
  for (const p of paths ?? []) {
    if (typeof p !== 'string' || p.length === 0) continue
    out.add(resolveRepoIdentity(p, 'best-effort'))
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
