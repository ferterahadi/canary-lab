import fs from 'fs'
import path from 'path'
import { runGit, type GitResult } from '../../../../shared/git-repo'
import { dirSizeBytes } from '../run-store'

// Inventory of every git worktree canary-lab created under the logs dir —
// per-run isolation worktrees, benchmark arm/staging worktrees, and lazily
// created "inspect" snapshots (plus any orphaned by a crashed run, which git
// still has registered). Powers the Log Cleanup worktree list so the user can
// visit or reclaim them. Worktrees share their source repo's object store, so
// removal must go through `git worktree remove` (see removeWorktree), never a
// plain rmdir — otherwise the source repo accumulates stale registrations.

export type WorktreeOwnerKind = 'run' | 'benchmark' | 'portify' | 'unknown'

export interface WorktreeEntry {
  /** Worktree root (absolute). */
  path: string
  /** The owning repo's git toplevel (where `git worktree remove` is run). */
  sourceRoot: string
  /** Short ref the worktree is checked out at (branch short-name or HEAD sha). */
  ref: string
  ownerKind: WorktreeOwnerKind
  /** Run/benchmark id parsed from the logs-relative path, or null. */
  ownerId: string | null
  /** Slot for benchmark worktrees: 'arm-A' | 'arm-B' | 'staging' | 'inspect'. */
  slot: string | null
  /** Disk size of the worktree dir (0 when the dir is gone). */
  bytes: number
  /** ms since the worktree root's mtime, or null when the dir is gone. */
  ageMs: number | null
  /** False when git still registers the worktree but the dir is missing (prunable). */
  exists: boolean
}

interface PorcelainWorktree {
  path: string
  ref: string
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated; the
 * first is always the main worktree (the repo root). We keep the path and a
 * human ref: the branch short-name, else the detached HEAD's short sha.
 */
export function parsePorcelainWorktrees(stdout: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = []
  let cur: { path?: string; head?: string; branch?: string } = {}
  const flush = (): void => {
    if (cur.path) {
      const ref = cur.branch
        ? cur.branch.replace(/^refs\/heads\//, '')
        : cur.head
          ? cur.head.slice(0, 7)
          : 'detached'
      out.push({ path: cur.path, ref })
    }
    cur = {}
  }
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') { flush(); continue }
    if (line.startsWith('worktree ')) cur.path = line.slice('worktree '.length)
    else if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length)
  }
  flush()
  return out
}

/** True when `child` is `parent` or lives inside it (no `..` escape). */
export function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' ? true : (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Classify a worktree path against the logs layout:
 *   <logsDir>/runs/<runId>/worktrees/<repo>
 *   <logsDir>/benchmarks/<benchId>/worktrees/<slot>/<repo>
 */
export function classifyWorktreePath(logsDir: string, worktreePath: string): {
  ownerKind: WorktreeOwnerKind
  ownerId: string | null
  slot: string | null
} {
  const rel = path.relative(logsDir, worktreePath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ownerKind: 'unknown', ownerId: null, slot: null }
  }
  const seg = rel.split(path.sep)
  if (seg[0] === 'runs' && seg[1]) return { ownerKind: 'run', ownerId: seg[1], slot: null }
  if (seg[0] === 'benchmarks' && seg[1]) {
    const slot = seg[2] === 'worktrees' ? (seg[3] ?? null) : null
    return { ownerKind: 'benchmark', ownerId: seg[1], slot }
  }
  // <logsDir>/portify/<workflowId>/worktrees/<repo>
  if (seg[0] === 'portify' && seg[1]) {
    const slot = seg[2] === 'worktrees' ? (seg[3] ?? null) : null
    return { ownerKind: 'portify', ownerId: seg[1], slot }
  }
  return { ownerKind: 'unknown', ownerId: null, slot: null }
}

type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>

/**
 * List every git worktree registered by the given source repos whose path lives
 * under `logsDir` (the canary-lab-created ones). The main worktree and any
 * worktree outside logsDir are excluded. `now` is injected for deterministic
 * ages in tests.
 */
export async function listWorktrees(opts: {
  logsDir: string
  sourceRoots: string[]
  now: number
  git?: GitRunner
}): Promise<WorktreeEntry[]> {
  const git = opts.git ?? runGit
  const seen = new Set<string>()
  const entries: WorktreeEntry[] = []
  for (const sourceRoot of opts.sourceRoots) {
    const res = await git(sourceRoot, ['worktree', 'list', '--porcelain'])
    if (res.code !== 0) continue
    for (const wt of parsePorcelainWorktrees(res.stdout)) {
      if (!isUnder(wt.path, opts.logsDir)) continue // skip the main worktree + anything outside logs
      if (seen.has(wt.path)) continue
      seen.add(wt.path)
      const { ownerKind, ownerId, slot } = classifyWorktreePath(opts.logsDir, wt.path)
      const exists = fs.existsSync(wt.path)
      let ageMs: number | null = null
      if (exists) {
        try { ageMs = Math.max(0, opts.now - fs.statSync(wt.path).mtimeMs) } catch { ageMs = null }
      }
      entries.push({
        path: wt.path,
        sourceRoot,
        ref: wt.ref,
        ownerKind,
        ownerId,
        slot,
        bytes: exists ? dirSizeBytes(wt.path) : 0,
        ageMs,
        exists,
      })
    }
  }
  return entries
}
