import fs from 'fs'
import { getGitStatus, runGit } from '../../../shared/git-repo'
import { resolveRepoPath } from '../../../shared/repo-identity'
import { porcelainPath } from '../../../shared/git-status-path'
import { normalizeFixCaptureNames } from './fix-capture-names'
import type { RunFixCapture, RunFixCaptureRepo } from '../../../../../../shared/run-state'
import type { ApplyFixResult, ApplyFixesOutcome } from '../../../../../../shared/run-pr'

// Apply a run's captured heal-fix patches (see RunFixCapture) INTO the real
// product repos on demand — the one place a run's edits reach the user's source
// tree, and only when they ask. Each repo's patch is applied 3-way so it lands
// even against a working tree that drifted a little since the run; a patch that
// won't merge cleanly is reported per-repo rather than aborting the others.
//
// This is the road the Changes tab's "Open in editor" drives down: the run's
// scratch worktree is long gone by then, so landing the patch here is what puts
// the repair into a tree the user's editor can actually show as changed files.

/**
 * Apply each captured patch into its source repo working tree with
 * `git apply --3way`. Pure I/O over git; no manifest mutation. The caller
 * (route) decides the HTTP shape.
 *
 * `repoName` narrows it to a single repo — the Changes tab opens one repo at a
 * time, and applying the other repos' patches as a side effect of opening this
 * one would edit trees the user never asked about. Omitted means every repo,
 * which is what the run-level "Apply locally" has always done.
 */
export async function applyFixCapture(
  fixCapture: RunFixCapture,
  opts: { repoName?: string } = {},
): Promise<ApplyFixesOutcome> {
  const results: ApplyFixResult[] = []
  const targets = opts.repoName
    ? fixCapture.repos.filter((r) => r.repoName === opts.repoName)
    : fixCapture.repos
  for (const repo of targets) {
    const root = resolveRepoPath(repo.repoRoot)
    if (!fs.existsSync(repo.patchPath)) {
      results.push({ repoName: repo.repoName, ok: false, reason: 'patch file is missing — re-run to refresh the fix' })
      continue
    }
    if (!fs.existsSync(root)) {
      results.push({ repoName: repo.repoName, ok: false, reason: `repo path no longer exists: ${root}` })
      continue
    }
    // --3way lets the patch merge against a working tree that drifted since the
    // run (falling back to blob-level merge); --whitespace=nowarn keeps a noisy
    // diff from failing the apply on whitespace alone.
    const applied = await runGit(root, ['apply', '--3way', '--whitespace=nowarn', repo.patchPath])
    if (applied.code === 0) {
      results.push({ repoName: repo.repoName, ok: true })
    } else {
      results.push({
        repoName: repo.repoName,
        ok: false,
        reason: (applied.stderr || applied.stdout).trim() || 'git apply failed (the repo may have moved since the run)',
      })
    }
  }
  return { results, allOk: results.length > 0 && results.every((r) => r.ok) }
}

/** What applying THIS repo's patch would land on, read live rather than from
 *  the run's start-of-run snapshot — the user has had the whole run to edit
 *  their tree since then. */
export interface ApplyTarget {
  repoName: string
  /** The `~`-resolved working tree the patch would land in. */
  repoRoot: string
  /** False when the path is gone or is no longer a git working tree — the one
   *  case where "open it in your editor" has nothing to open. */
  ready: boolean
  reason?: string
  /** Uncommitted paths that are NOT this run's own repair. These are what make
   *  the editor's changed-file list ambiguous, so this — not raw dirtiness — is
   *  what the confirm is worth interrupting for: re-opening a repo the user
   *  already applied into would otherwise nag on every click. */
  foreignDirty: string[]
  /** Branch those edits would land on, so the confirm can name it. */
  branch: string | null
  /** Whether the repair is in this repo yet. The run edited an isolated copy,
   *  so nothing lands here until someone applies or merges it. Read from the
   *  repo itself (the patch reverses cleanly against the working tree), not
   *  from what this UI remembers doing. Absent when there is no patch to test. */
  inRepo?: RepairInRepo
}

/** `absent` — the repo doesn't hold the repair; `uncommitted` — it does, with
 *  some of the repair's files still uncommitted; `committed` — it does, and
 *  every one of the repair's files is committed. */
export type RepairInRepo = 'absent' | 'uncommitted' | 'committed'

/** Read every captured repo's current state, so the Changes tab knows which
 *  cards can offer to open and which need to warn first. Missing/non-repo paths
 *  are not ready; failed Git reads reject rather than present clean evidence. */
export async function buildApplyPreflight(fixCapture: RunFixCapture, readStatus = getGitStatus): Promise<ApplyTarget[]> {
  return Promise.all(fixCapture.repos.map((repo) => applyTargetFor(repo, readStatus)))
}

/** Whether `repoRoot`'s working tree already holds the patch. `--check` writes
 *  nothing; a patch that reverses cleanly is one whose result is all there. */
async function repairInRepo(repoRoot: string, patchPath: string, repairFiles: ReadonlySet<string>, dirty: readonly string[]): Promise<RepairInRepo | undefined> {
  if (!fs.existsSync(patchPath) || fs.statSync(patchPath).size === 0) return undefined
  const reversed = await runGit(repoRoot, ['apply', '--reverse', '--check', '--whitespace=nowarn', patchPath])
  if (reversed.code !== 0) return 'absent'
  return dirty.some((p) => repairFiles.has(p)) ? 'uncommitted' : 'committed'
}

/** The paths a patch touches, for a capture recorded before file names were. */
async function patchPaths(repoRoot: string, patchPath: string): Promise<string[]> {
  const numstat = await runGit(repoRoot, ['apply', '--numstat', patchPath])
  if (numstat.code !== 0) return []
  return numstat.stdout.split('\n').filter(Boolean).map((line) => line.split('\t').slice(2).join('\t'))
}

async function applyTargetFor(repo: RunFixCaptureRepo, readStatus: typeof getGitStatus): Promise<ApplyTarget> {
  const repoRoot = resolveRepoPath(repo.repoRoot)
  if (!fs.existsSync(repoRoot)) {
    return { repoName: repo.repoName, repoRoot, ready: false, reason: 'the repo path no longer exists', foreignDirty: [], branch: null }
  }
  const status = await readStatus(repoRoot)
  if (!status.isGitRepo) {
    return { repoName: repo.repoName, repoRoot, ready: false, reason: 'not a git working tree', foreignDirty: [], branch: null }
  }
  const fixFiles = new Set(normalizeFixCaptureNames(repo).fileNames ?? [])
  const dirty = status.dirtyFiles.map(porcelainPath)
  const repairFiles = fixFiles.size > 0 ? fixFiles : new Set(await patchPaths(repoRoot, repo.patchPath))
  const inRepo = await repairInRepo(repoRoot, repo.patchPath, repairFiles, dirty)
  return {
    repoName: repo.repoName,
    repoRoot,
    ready: true,
    foreignDirty: dirty.filter((p) => !fixFiles.has(p)),
    branch: status.currentBranch,
    ...(inRepo ? { inRepo } : {}),
  }
}
