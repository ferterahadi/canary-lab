// What the heal agent actually edited during its turn.
//
// Snapshot every git-tracked edit surface in the feature before the agent has
// the floor, then diff it afterwards. This is ground truth for two things that
// must not rest on the agent's own account of itself: the journal entry's
// `fix.file` line, and which services the orchestrator restarts.
//
// Split out of orchestrator.ts. Pure functions over a feature config and a git
// working tree — no run state — which is what lets the snapshot/diff pairing be
// tested against real repos instead of only through a live heal cycle.

import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import {
  diffContentSinceSnapshot,
  diffNamesSinceSnapshot,
  getGitRoot,
  resolveRepoPath,
  snapshotWorkingTree,
  type DiffPathspec,
} from '../../../../shared/git-repo'

export interface FeatureRepoSnapshot {
  ref: string
  gitRoot: string
  pathspecs?: readonly DiffPathspec[]
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// Snapshot every git-tracked edit surface in the feature just before the agent
// has the floor. The returned map is the input to `diffFeatureRepos`. Two kinds
// of entries:
//
//   1. **Service repo** (one per `feature.repos[]`): keyed by `localPath`,
//      diffed in full. `localPath` is assumed to be a git working-tree root, so
//      paths returned by `git diff --name-only` join directly.
//
//   2. **Feature directory** (`feature.featureDir`): keyed by `featureDir`,
//      diffed via pathspec scoped to the feature subtree of whatever git repo
//      owns it (typically the workspace repo). Service-repo subtrees nested
//      under the feature dir are excluded so they aren't double-counted.
//      Captures the agent's edits to `e2e/helpers/`, test specs, and feature
//      docs — none of which live in any service repo.
//
// Entries that aren't git working trees are silently omitted — the diff for
// them is empty, which yields a `restart([])` (restart everything) fallback
// identical to the behavior when the agent didn't declare files.
export async function snapshotFeatureRepos(
  feature: FeatureConfig,
): Promise<Map<string, FeatureRepoSnapshot>> {
  const snapshots = new Map<string, FeatureRepoSnapshot>()
  const serviceRepoRoots: string[] = []
  for (const repo of feature.repos ?? []) {
    const localPath = repo.localPath
    if (typeof localPath !== 'string') continue
    const ref = await snapshotWorkingTree(localPath)
    if (ref === null) continue
    const absRoot = resolveRepoPath(localPath)
    snapshots.set(localPath, { ref, gitRoot: absRoot })
    serviceRepoRoots.push(absRoot)
  }

  // Layer the feature dir on top: it lives inside a workspace-level git repo
  // (one .git for the whole workspace), so we snapshot from there and scope the
  // diff to `feature.featureDir` via pathspec. Excludes any service-repo
  // subtree that's nested under it.
  const featureDir = feature.featureDir
  if (typeof featureDir === 'string' && featureDir.length > 0) {
    const featureDirAbs = resolveRepoPath(featureDir)
    const gitRoot = await getGitRoot(featureDirAbs)
    const ref = await snapshotWorkingTree(featureDirAbs)
    if (gitRoot !== null && ref !== null && !snapshots.has(featureDir)) {
      const excludes = serviceRepoRoots
        .filter((root) => isPathInside(root, featureDirAbs))
        .map((root) => `:(exclude)${root}` satisfies DiffPathspec)
      const pathspecs: DiffPathspec[] = [featureDirAbs, ...excludes]
      snapshots.set(featureDir, { ref, gitRoot, pathspecs })
    }
  }

  return snapshots
}

// Diff each snapshotted tree and return absolute paths of the files the agent
// touched between snapshot and now. Ground truth for both the journal entry's
// `fix.file` line and the orchestrator's restart planning.
export async function diffFeatureRepos(
  snapshots: Map<string, FeatureRepoSnapshot>,
): Promise<string[]> {
  const out: string[] = []
  for (const [, snap] of snapshots) {
    const relPaths = await diffNamesSinceSnapshot(snap.gitRoot, snap.ref, snap.pathspecs)
    for (const rel of relPaths) {
      out.push(path.join(snap.gitRoot, rel))
    }
  }
  return out
}

// Full unified-diff content (not just names) for each snapshotted tree, joined
// into one string. Multi-tree features get a `# repo: <key>` header before each
// diff so the agent (and a human reviewer) can tell which tree each hunk came
// from. Truncation to MAX_JOURNAL_DIFF_BYTES happens at the journal-writer
// layer.
export async function diffContentForFeatureRepos(
  snapshots: Map<string, FeatureRepoSnapshot>,
): Promise<string> {
  const blocks: string[] = []
  const multiTree = snapshots.size > 1
  for (const [key, snap] of snapshots) {
    const content = await diffContentSinceSnapshot(snap.gitRoot, snap.ref, snap.pathspecs)
    if (!content.trim()) continue
    blocks.push(multiTree ? `# repo: ${key}\n${content}` : content)
  }
  return blocks.join('\n')
}
