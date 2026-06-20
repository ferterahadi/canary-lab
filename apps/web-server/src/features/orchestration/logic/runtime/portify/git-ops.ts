import fs from 'fs'
import { runGit, diffContentSinceSnapshot } from '../../git-repo'
import { addWorktree, removeWorktree, linkNodeModules, type WorktreeHandle } from '../repo-worktree'

// Branch + worktree + diff + overlay-apply/reverse mechanics for the
// port-ification workflow. The agent edits on a dedicated scratch branch in an
// isolated worktree cut off committed HEAD; the verified diff is captured as the
// feature's ephemeral overlay (the scratch worktree+branch are then discarded —
// NOTHING lands in the product repo). At run time the overlay is applied into a
// fresh per-run worktree and reverse-applied at teardown.

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

// --- Ephemeral overlay apply/reverse ------------------------------------------
//
// The ephemeral-overlay model NEVER commits or merges. Instead a captured patch
// is applied into a per-run worktree before boot and reverse-applied at
// teardown. These helpers are the git mechanics for that; they never remove the
// worktree (the worktree outlives the overlay — it holds the heal agent's
// repair edits we must preserve).

export type ApplyOutcome =
  | { kind: 'ok' }
  /** The patch couldn't apply cleanly because the target lines drifted (e.g. a
   *  heal edit on the same lines). For reverse, the file is left INTACT. */
  | { kind: 'conflict'; files: string[]; detail: string }
  /** A hard failure (corrupt patch, missing base blob) — nothing was applied. */
  | { kind: 'error'; detail: string }

function isBlankPatch(patchPath: string): boolean {
  try {
    return fs.readFileSync(patchPath, 'utf-8').trim().length === 0
  } catch {
    return false
  }
}

/** Repo-relative paths a patch touches, parsed without applying it. */
async function patchFiles(worktreeRoot: string, patchPath: string): Promise<string[]> {
  const res = await runGit(worktreeRoot, ['apply', '--numstat', '-z', patchPath])
  if (res.code !== 0) return []
  // `--numstat -z`: NUL-separated records of `added \t removed \t path`.
  return res.stdout
    .split('\0')
    .map((rec) => rec.split('\t')[2]?.trim())
    .filter((p): p is string => Boolean(p))
}

/** Conflicted paths reported by `git apply --3way` (lines like `U path`). */
function parseUnmergedFiles(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((l) => /^U\s+(.+)$/.exec(l.trim())?.[1])
    .filter((p): p is string => Boolean(p))
}

/**
 * Apply the overlay patch into a worktree. Tries a plain working-tree apply
 * first (no `--index`, so it doesn't require the worktree to match the git
 * index — a per-run worktree boots, it isn't committed), then falls back to
 * `--3way` to tolerate benign base drift via the recorded blobs. A blank patch
 * is a no-op `ok` (the repo's app already honored the injected port). On true
 * conflict the 3-way merge leaves markers — surfaced as `conflict`; the caller
 * must NOT boot.
 */
export async function applyOverlay(worktreeRoot: string, patchPath: string): Promise<ApplyOutcome> {
  if (isBlankPatch(patchPath)) return { kind: 'ok' }
  const plain = await runGit(worktreeRoot, ['apply', patchPath])
  if (plain.code === 0) return { kind: 'ok' }
  // Plain apply failed (e.g. the user's HEAD drifted under the patch) — retry
  // with a 3-way merge, which reconstructs via the blobs recorded in the patch.
  const three = await runGit(worktreeRoot, ['apply', '--3way', patchPath])
  if (three.code === 0) return { kind: 'ok' }
  const detail = `${three.stderr}${three.stdout}${plain.stderr}${plain.stdout}`.trim()
  const files = parseUnmergedFiles(three.stderr)
  if (files.length > 0) return { kind: 'conflict', files, detail }
  return { kind: 'error', detail }
}

/**
 * Reverse-apply the overlay patch (`git apply -R`) at teardown. Plain reverse is
 * ATOMIC — on failure the files are left untouched, preserving the heal agent's
 * edits even when they overlap the patched lines (surfaced as `conflict`). Never
 * removes the worktree. A blank patch is a no-op `ok`.
 */
export async function reverseOverlay(worktreeRoot: string, patchPath: string): Promise<ApplyOutcome> {
  if (isBlankPatch(patchPath)) return { kind: 'ok' }
  const res = await runGit(worktreeRoot, ['apply', '-R', patchPath])
  if (res.code === 0) return { kind: 'ok' }
  const detail = `${res.stderr}${res.stdout}`.trim()
  // Plain `git apply -R` is atomic: a non-zero exit means nothing changed, so
  // the heal edits are intact. Report which files the patch covers.
  const files = await patchFiles(worktreeRoot, patchPath)
  return { kind: 'conflict', files, detail }
}

/** Remove the worktree and delete the (unmerged) branch from the source repo. */
export async function discardWorktree(handle: WorktreeHandle, branch: string): Promise<void> {
  await removeWorktree(handle)
  // `worktree remove` doesn't delete the branch ref — do it explicitly. Safe on
  // discard since we're throwing away all the work. (runGit never rejects; a
  // missing branch just returns a non-zero code we ignore.)
  await runGit(handle.sourceRoot, ['branch', '-D', branch])
}
