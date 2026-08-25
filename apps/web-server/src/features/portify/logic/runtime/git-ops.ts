import fs from 'fs'
import path from 'path'
import { runGit, diffContentSinceSnapshot } from '../../../../shared/git-repo'
import { addWorktree, removeWorktree, linkNodeModules, type WorktreeHandle } from '../../../runs/logic/runtime/repo-worktree'

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

export interface PortifyEditProgress {
  /** Changes as the worktree changes — the stage's liveness key. */
  digest: string
  /** Files touched across every scratch worktree, for the UI. */
  files: number
}

/** Liveness fingerprint of an IN-PROGRESS edit session, cheap enough to poll.
 *
 *  Why this exists: an EXTERNAL portify parks at `status:'editing'` and never
 *  advances `attempt`, so the flight stage's liveness key (`status#attempt`)
 *  freezes for the whole hand-off. Against a 30-minute idle budget that means a
 *  client legitimately editing for longer gets its workflow ABANDONED mid-flight
 *  — the same class of bug the idle budget was introduced to fix for slow
 *  double-boots.
 *
 *  `git status --porcelain` rather than `diff --name-only` on purpose: it counts
 *  UNTRACKED files too, so a client that adds a file registers as progress, and
 *  it reflects staged and unstaged work alike.
 *
 *  Porcelain alone is NOT enough, though — it reports status codes and paths, so
 *  it freezes the moment a file first shows as modified, and a client spending
 *  twenty minutes on one listener would still look idle. So the digest also folds
 *  in each listed file's mtime, which moves on every save regardless of whether
 *  the content grew, shrank, or stayed the same length.
 *
 *  Evidence, not self-report: this reads the worktree Canary owns. A silent or
 *  vanished client freezes the fingerprint and still dies on the idle budget,
 *  which is the behaviour that makes the timeout worth keeping. */
export async function editFingerprint(
  repos: Array<{ worktreePath?: string }>,
): Promise<PortifyEditProgress> {
  const parts: string[] = []
  let files = 0
  for (const repo of repos) {
    if (!repo.worktreePath) continue
    const res = await runGit(repo.worktreePath, ['status', '--porcelain'])
    if (res.code !== 0) {
      // A git failure must not read as "no progress" — that would resurrect the
      // abandonment this exists to prevent. Emit a stable marker instead, so the
      // fingerprint only freezes when the WORKTREE genuinely stops changing.
      parts.push('unreadable')
      continue
    }
    const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
    files += lines.length
    // Porcelain columns are `XY <path>` (and `XY <old> -> <new>` for a rename, so
    // take the LAST token). mtime is best-effort: a path we cannot stat just
    // contributes nothing rather than breaking the fingerprint.
    const stamps = lines.map((line) => {
      // A rename reads `R  old -> new`; everything else is just `XY path`. Written
      // as an explicit ternary rather than `split(' -> ').pop() ?? ''` so both
      // arms are reachable — the `??` fallback there was dead, since a split
      // always yields at least one element.
      const cells = line.slice(3).trim()
      const arrow = cells.lastIndexOf(' -> ')
      const rel = arrow === -1 ? cells : cells.slice(arrow + 4)
      try {
        return `${rel}@${fs.statSync(path.join(repo.worktreePath as string, rel)).mtimeMs}`
      } catch {
        return rel
      }
    })
    parts.push(digestOf(`${res.stdout}\n${stamps.join('\n')}`))
  }
  return { digest: parts.join('|'), files }
}

/** Small, fast, order-stable digest — collision resistance is irrelevant here
 *  (we only ask "did this change since the last poll?"), so a cryptographic hash
 *  would be cost without benefit. */
function digestOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `${text.length}:${(h >>> 0).toString(36)}`
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

/**
 * Hard-reset a scratch worktree's tracked files back to its HEAD, discarding any
 * working-tree changes. Used to scrub a worktree after a seed `applyOverlay`
 * returned `conflict`/`error`: a `--3way` seed leaves conflict markers in the
 * files even when it reports failure, and the agent must start from a CLEAN
 * checkout (the seed is a best-effort optimization, never load-bearing). Resets
 * tracked files only — the linked `node_modules` is untracked and untouched.
 */
export async function resetWorktree(worktreeRoot: string): Promise<void> {
  // The scratch branch was just cut at HEAD with no commits, so HEAD is the
  // clean baseline. `reset --hard` restores both the index and the working tree,
  // clearing any half-applied 3-way merge and its markers.
  await runGit(worktreeRoot, ['reset', '--hard', 'HEAD'])
}

/** Remove the worktree and delete the (unmerged) branch from the source repo. */
export async function discardWorktree(handle: WorktreeHandle, branch: string): Promise<void> {
  await removeWorktree(handle)
  // `worktree remove` doesn't delete the branch ref — do it explicitly. Safe on
  // discard since we're throwing away all the work. (runGit never rejects; a
  // missing branch just returns a non-zero code we ignore.)
  await runGit(handle.sourceRoot, ['branch', '-D', branch])
}
