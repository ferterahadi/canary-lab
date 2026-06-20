import fs from 'fs'
import path from 'path'
import { getGitRoot, resolveRepoPath, runGit } from '../../../../shared/git-repo'

/**
 * Per-run git worktree isolation. Created only when the user opts in after a
 * same-repo collision (see repo-collision.ts) so two runs editing the same app
 * don't corrupt each other. `git worktree add` gives the second run a separate
 * checkout that shares the object store — cheap on disk, fully isolated for
 * edits. Cleaned up when the run ends.
 *
 * Note: a feature's `localPath` is often a SUBDIRECTORY of a larger workspace
 * repo, not the repo root. We add the worktree at the repo root and remap the
 * localPath into the worktree, preserving the subpath so the service `cwd` and
 * heal edits land in the isolated tree.
 */

export interface WorktreeHandle {
  repoName: string
  /** Git toplevel of the source repo. */
  sourceRoot: string
  /** Toplevel of the new per-run worktree. */
  worktreeRoot: string
  /** The repo's `localPath` remapped into the worktree (subpath preserved). */
  localPath: string
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
}

/** True when `localPath` lives inside a git working tree (so it can be worktree-isolated). */
export async function isGitWorktreeCapable(localPath: string): Promise<boolean> {
  return (await getGitRoot(localPath)) !== null
}

/**
 * Create a per-run worktree for the repo containing `localPath`. Throws if the
 * path is not inside a git repo (caller should fall back to queueing) or the
 * `git worktree add` fails. `worktreesDir` is typically `<runDir>/worktrees`.
 */
export async function addWorktree(opts: {
  repoName: string
  localPath: string
  worktreesDir: string
  /** Ref to base the worktree on. Defaults to the source's current HEAD. */
  branch?: string
}): Promise<WorktreeHandle> {
  const requested = resolveRepoPath(opts.localPath)
  const sourceRoot = await getGitRoot(requested)
  if (!sourceRoot) {
    throw Object.assign(new Error(`repo "${opts.repoName}" at ${requested} is not a git working tree`), {
      code: 'NOT_A_GIT_REPO',
    })
  }
  // `git rev-parse --show-toplevel` canonicalizes symlinks (e.g. /tmp ->
  // /private/tmp on macOS). Canonicalize the requested path the same way so the
  // computed subpath is clean rather than littered with `..` segments.
  // Safe to call unguarded: getGitRoot already confirmed the path exists.
  const resolved = fs.realpathSync(requested)
  const rel = path.relative(sourceRoot, resolved)
  const worktreeRoot = path.join(opts.worktreesDir, safeName(opts.repoName))
  fs.mkdirSync(opts.worktreesDir, { recursive: true })

  const ref = opts.branch ?? 'HEAD'
  const res = await runGit(sourceRoot, ['worktree', 'add', '--detach', worktreeRoot, ref])
  if (res.code !== 0) {
    throw new Error(`git worktree add failed for "${opts.repoName}": ${`${res.stderr}${res.stdout}`.trim()}`)
  }

  return {
    repoName: opts.repoName,
    sourceRoot,
    worktreeRoot,
    localPath: rel && rel !== '' ? path.join(worktreeRoot, rel) : worktreeRoot,
  }
}

// Git worktrees don't include gitignored deps, so a fresh worktree has no
// node_modules — services (`npx tsx ...`) and Playwright can't resolve. Symlink
// the source repo's node_modules into the worktree root so resolution works.
// Best-effort: boot surfaces a clearer error if deps are genuinely missing.
export function linkNodeModules(handle: Pick<WorktreeHandle, 'sourceRoot' | 'worktreeRoot'>): void {
  const src = path.join(handle.sourceRoot, 'node_modules')
  const dst = path.join(handle.worktreeRoot, 'node_modules')
  try {
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst, 'dir')
  } catch {
    /* best-effort */
  }
}

/** Remove a worktree. Best-effort: prunes stale metadata if the dir is gone. */
export async function removeWorktree(handle: Pick<WorktreeHandle, 'sourceRoot' | 'worktreeRoot'>): Promise<void> {
  const res = await runGit(handle.sourceRoot, ['worktree', 'remove', '--force', handle.worktreeRoot])
  if (res.code !== 0) {
    // The directory may already be gone (e.g. runDir wiped) — drop dangling
    // metadata so the source repo doesn't accumulate stale worktree entries.
    await runGit(handle.sourceRoot, ['worktree', 'prune'])
    try { fs.rmSync(handle.worktreeRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
