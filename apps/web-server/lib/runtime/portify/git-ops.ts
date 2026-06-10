import { runGit, diffContentSinceSnapshot } from '../../git-repo'
import { addWorktree, removeWorktree, linkNodeModules, type WorktreeHandle } from '../repo-worktree'

// Branch + worktree + diff + commit/discard mechanics for the port-ification
// workflow. The agent edits on a dedicated branch in an isolated worktree cut
// off committed HEAD; the commit (on user confirm) lands on that branch in the
// product repo, leaving the user's main working tree untouched.

export function portifyBranchName(feature: string): string {
  const slug = feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'feature'
  return `canary/dynamic-ports-${slug}`
}

export interface PortifyWorktree {
  handle: WorktreeHandle
  branch: string
  baseSha: string
  /** Snapshot ref captured before the agent edits — diff is taken against it. */
  snapshotRef: string
}

export async function createBranchAndWorktree(opts: {
  repoName: string
  localPath: string
  worktreesDir: string
  branch: string
}): Promise<PortifyWorktree> {
  // Detached worktree at HEAD, then create + switch to the named branch inside
  // it. (addWorktree only does --detach; the branch is ours.)
  const handle = await addWorktree({
    repoName: opts.repoName,
    localPath: opts.localPath,
    worktreesDir: opts.worktreesDir,
    branch: 'HEAD',
  })
  const baseRev = await runGit(handle.worktreeRoot, ['rev-parse', 'HEAD'])
  const baseSha = baseRev.stdout.trim()
  const co = await runGit(handle.worktreeRoot, ['checkout', '-B', opts.branch])
  if (co.code !== 0) {
    await removeWorktree(handle) // best-effort; removeWorktree never rejects
    throw new Error(`failed to create branch ${opts.branch}: ${`${co.stderr}${co.stdout}`.trim()}`)
  }
  linkNodeModules(handle)
  // The worktree was just created at HEAD and is clean, so HEAD is the diff
  // baseline for the agent's (uncommitted) edits.
  return { handle, branch: opts.branch, baseSha, snapshotRef: 'HEAD' }
}

/** Full unified diff of the agent's edits, scoped to the worktree. */
export async function captureDiff(worktreeRoot: string, snapshotRef: string): Promise<string> {
  return diffContentSinceSnapshot(worktreeRoot, snapshotRef)
}

/** Names of changed files since the snapshot (used to assert tests untouched). */
export async function changedFiles(worktreeRoot: string, snapshotRef: string): Promise<string[]> {
  const res = await runGit(worktreeRoot, ['diff', '--name-only', snapshotRef])
  if (res.code !== 0) return []
  return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

/**
 * Stage + commit the agent's edits on the branch. Returns the new commit SHA,
 * or null when this worktree has no changes to commit (e.g. a repo whose app
 * already honored an injected port — only the config changed, which lives
 * outside the worktree). The caller decides what to do with an empty repo.
 */
export async function commitWorktree(worktreeRoot: string, message: string): Promise<string | null> {
  await runGit(worktreeRoot, [
    'add', '-A', '--', '.',
    ':(exclude)node_modules',
    ':(exclude)test-results',
    ':(exclude)playwright-report',
    ':(exclude)blob-report',
    ':(exclude).cache',
  ])
  const staged = await runGit(worktreeRoot, ['diff', '--cached', '--name-only'])
  if (!staged.stdout.trim()) return null
  const commit = await runGit(worktreeRoot, [
    '-c', 'user.name=canary-lab', '-c', 'user.email=portify@canary-lab',
    'commit', '-m', message, '--no-verify',
  ])
  if (commit.code !== 0) {
    throw new Error(`commit failed: ${`${commit.stderr}${commit.stdout}`.trim()}`)
  }
  const rev = await runGit(worktreeRoot, ['rev-parse', 'HEAD'])
  return rev.stdout.trim()
}

export interface RepoMergeStatus {
  branchExists: boolean
  /** Currently checked-out branch; null when HEAD is detached. */
  currentBranch: string | null
  dirty: boolean
  mergeInProgress: boolean
  /** The portify work (commitSha when given, else the branch tip) is an ancestor of HEAD. */
  merged: boolean
}

/**
 * Live merge readiness of the USER'S repo (not a worktree). `merged` is
 * computed, not recorded — a manual `git merge` in a terminal counts. When the
 * branch was deleted after merging, pass the commit sha so merged-ness still
 * resolves.
 */
export async function mergeStatus(repoRoot: string, branch: string, commitSha?: string): Promise<RepoMergeStatus> {
  const branchRes = await runGit(repoRoot, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`])
  const branchExists = branchRes.code === 0
  const headRes = await runGit(repoRoot, ['symbolic-ref', '-q', '--short', 'HEAD'])
  const currentBranch = headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : null
  const statusRes = await runGit(repoRoot, ['status', '--porcelain', '--', '.'])
  const dirty = Boolean(statusRes.stdout.trim())
  const mergeHead = await runGit(repoRoot, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  const mergeInProgress = mergeHead.code === 0
  const ref = commitSha ?? (branchExists ? branch : null)
  let merged = false
  if (ref) {
    const anc = await runGit(repoRoot, ['merge-base', '--is-ancestor', ref, 'HEAD'])
    merged = anc.code === 0
  }
  return { branchExists, currentBranch, dirty, mergeInProgress, merged }
}

export type MergeOutcome =
  | { ok: true; mergeCommitSha: string; alreadyMerged: boolean }
  | { ok: false; conflictFiles: string[] }

/**
 * Merge the portify branch into the repo's currently checked-out branch — the
 * one git operation that DOES touch the user's tree, so it refuses any state
 * it can't merge cleanly from, and on conflict it aborts and reports rather
 * than leaving conflict markers behind.
 */
export async function mergePortifyBranch(repoRoot: string, branch: string): Promise<MergeOutcome> {
  const s = await mergeStatus(repoRoot, branch)
  if (!s.branchExists) throw new Error(`branch ${branch} does not exist in ${repoRoot}`)
  if (s.mergeInProgress) throw new Error(`a merge is already in progress in ${repoRoot} — conclude or abort it first`)
  if (s.currentBranch == null) throw new Error(`HEAD is detached in ${repoRoot} — check out a branch to merge into`)
  if (s.dirty) throw new Error(`${repoRoot} has uncommitted changes — commit or stash them before merging`)
  if (s.merged) {
    const head = await runGit(repoRoot, ['rev-parse', 'HEAD'])
    return { ok: true, mergeCommitSha: head.stdout.trim(), alreadyMerged: true }
  }
  const merge = await runGit(repoRoot, [
    '-c', 'user.name=canary-lab', '-c', 'user.email=portify@canary-lab',
    'merge', '--no-edit', '--no-verify', branch,
  ])
  if (merge.code !== 0) {
    const unmerged = await runGit(repoRoot, ['diff', '--name-only', '--diff-filter=U'])
    const conflictFiles = unmerged.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    await runGit(repoRoot, ['merge', '--abort'])
    if (conflictFiles.length > 0) return { ok: false, conflictFiles }
    throw new Error(`merge failed: ${`${merge.stderr}${merge.stdout}`.trim()}`)
  }
  const head = await runGit(repoRoot, ['rev-parse', 'HEAD'])
  return { ok: true, mergeCommitSha: head.stdout.trim(), alreadyMerged: false }
}

/** Remove the worktree and delete the (unmerged) branch from the source repo. */
export async function discardWorktree(handle: WorktreeHandle, branch: string): Promise<void> {
  await removeWorktree(handle)
  // `worktree remove` doesn't delete the branch ref — do it explicitly. Safe on
  // discard since we're throwing away all the work. (runGit never rejects; a
  // missing branch just returns a non-zero code we ignore.)
  await runGit(handle.sourceRoot, ['branch', '-D', branch])
}
