import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import type { RunManifest } from '../../../../../../../shared/run-manifest'
import { getGitRoot, runGit } from '../../../../shared/git-repo'
import { resolveRepoIdentity, resolveRepoPath } from '../../../../shared/repo-identity'

/** The tree one block of a cycle's diff was taken from. */
export type CycleTree =
  /** `suitePrefix` is the feature dir relative to its git root, `''` when it
   * is the root, and null when no git root is known. */
  | { kind: 'feature-dir'; gitRoot: string | null; suitePrefix: string | null }
  /** `dir` is null when no usable repository is on disk any more. */
  | { kind: 'repo'; dir: string | null }
  | { kind: 'unknown' }

interface RepoCandidate { name: string | null; path: string }

const identity = (value: string): string => resolveRepoIdentity(value, 'best-effort')

/** Resolve a diff block's snapshot key against the run's own records and the
 * suite's config. A key is text from the diff, so it only ever selects one of
 * those known trees: git never runs in a path the run did not record. A diff
 * of a single tree carries no key, and the run's repos then say which it was. */
export async function resolveCycleTree(key: string | undefined, manifest: RunManifest, feature: FeatureConfig | undefined): Promise<CycleTree> {
  const featureDirs = [manifest.featureDir, feature?.featureDir].filter((dir): dir is string => Boolean(dir))
  const repoPaths = manifest.repoPaths ?? []
  const candidates: RepoCandidate[] = [
    ...Object.entries(manifest.worktrees ?? {}).map(([name, dir]) => ({ name, path: dir })),
    ...repoPaths.map((dir) => ({ name: repoName(dir, manifest, feature), path: dir })),
    ...(feature?.repos ?? []).map((repo) => ({ name: repo.name, path: repo.localPath })),
  ]
  if (key === undefined) {
    if (repoPaths.length === 0) return featureDirs.length ? featureDirTree(featureDirs[0]) : { kind: 'unknown' }
    if (repoPaths.length === 1) return repoTree({ name: repoName(repoPaths[0], manifest, feature), path: repoPaths[0] }, feature)
    return { kind: 'unknown' }
  }
  const wanted = identity(key)
  const featureDir = featureDirs.find((dir) => identity(dir) === wanted)
  if (featureDir) return featureDirTree(featureDir)
  const repo = candidates.find((candidate) => identity(candidate.path) === wanted)
  return repo ? repoTree(repo, feature) : { kind: 'unknown' }
}

function repoName(dir: string, manifest: RunManifest, feature: FeatureConfig | undefined): string | null {
  const wanted = identity(dir)
  return manifest.repoBranches?.find((repo) => identity(repo.path) === wanted)?.name
    ?? feature?.repos?.find((repo) => identity(repo.localPath) === wanted)?.name
    ?? null
}

async function usableRepo(dir: string): Promise<boolean> {
  const inside = await runGit(identity(dir), ['rev-parse', '--is-inside-work-tree'])
  return inside.code === 0 && inside.stdout.trim() === 'true'
}

/** A run's worktree shares its parent's object store, so when the worktree is
 * gone (or its `.git` link dangles) the configured checkout of the same repo
 * can still hold the blobs. */
async function repoTree(repo: RepoCandidate, feature: FeatureConfig | undefined): Promise<CycleTree> {
  if (await usableRepo(repo.path)) return { kind: 'repo', dir: identity(repo.path) }
  const configured = repo.name === null ? undefined : feature?.repos?.find((item) => item.name === repo.name)?.localPath
  if (configured && await usableRepo(configured)) return { kind: 'repo', dir: identity(configured) }
  return { kind: 'repo', dir: null }
}

/** A deleted feature dir still has its git root found from the nearest parent
 * on disk, so its suite copy can still be read by the diff's paths. */
async function featureDirTree(dir: string): Promise<CycleTree> {
  const target = path.resolve(resolveRepoPath(dir))
  let existing = target
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  const gitRoot = await getGitRoot(existing)
  if (!gitRoot) return { kind: 'feature-dir', gitRoot: null, suitePrefix: null }
  // git names its root by the physical path; resolve the part on disk the
  // same way so a symlinked parent cannot put the feature dir "outside" it.
  const physical = path.join(fs.realpathSync(existing), path.relative(existing, target))
  return { kind: 'feature-dir', gitRoot, suitePrefix: path.relative(gitRoot, physical).split(path.sep).join('/') }
}

/** A diff path relative to the suite, or null when it lies outside it. */
export function suiteRelativePath(tree: Extract<CycleTree, { kind: 'feature-dir' }>, diffPath: string): string | null {
  if (tree.suitePrefix === null) return null
  if (tree.suitePrefix === '') return diffPath
  return diffPath.startsWith(`${tree.suitePrefix}/`) ? diffPath.slice(tree.suitePrefix.length + 1) : null
}
