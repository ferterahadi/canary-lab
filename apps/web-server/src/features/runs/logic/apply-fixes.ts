import fs from 'fs'
import { getGitStatus, resolveRepoPath, runGit } from '../../../shared/git-repo'
import type { RunFixCapture, RunFixCaptureRepo } from '../../../../../../shared/run-state'

// Apply a run's captured heal-fix patches (see RunFixCapture) INTO the real
// product repos on demand — the one place a run's edits reach the user's source
// tree, and only when they ask. Each repo's patch is applied 3-way so it lands
// even against a working tree that drifted a little since the run; a patch that
// won't merge cleanly is reported per-repo rather than aborting the others.
//
// This is the road the Changes tab's "Open in editor" drives down: the run's
// scratch worktree is long gone by then, so landing the patch here is what puts
// the repair into a tree the user's editor can actually show as changed files.

export interface ApplyFixResult {
  repoName: string
  /** True when the patch applied (cleanly or 3-way merged) into the repo. */
  ok: boolean
  /** Failure reason (git stderr) when `ok` is false — e.g. a 3-way conflict or
   *  a patch that no longer applies because the repo moved on. */
  reason?: string
}

export interface ApplyFixesOutcome {
  results: ApplyFixResult[]
  allOk: boolean
}

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
}

/** Path out of a `git status --porcelain` line: 2 status columns, a space, then
 *  the path — and for a rename, the destination after the ` -> `. */
export function porcelainPath(line: string): string {
  const withoutStatus = line.slice(3)
  const arrow = withoutStatus.lastIndexOf(' -> ')
  return (arrow >= 0 ? withoutStatus.slice(arrow + 4) : withoutStatus).replace(/^"|"$/g, '')
}

/** Read every captured repo's current state, so the Changes tab knows which
 *  cards can offer to open and which need to warn first. Never throws: a repo
 *  git cannot describe comes back `ready:false` with the reason on it. */
export async function buildApplyPreflight(fixCapture: RunFixCapture): Promise<ApplyTarget[]> {
  return Promise.all(fixCapture.repos.map((repo) => applyTargetFor(repo)))
}

async function applyTargetFor(repo: RunFixCaptureRepo): Promise<ApplyTarget> {
  const repoRoot = resolveRepoPath(repo.repoRoot)
  if (!fs.existsSync(repoRoot)) {
    return { repoName: repo.repoName, repoRoot, ready: false, reason: 'the repo path no longer exists', foreignDirty: [], branch: null }
  }
  const status = await getGitStatus(repoRoot)
  if (!status.isGitRepo) {
    return { repoName: repo.repoName, repoRoot, ready: false, reason: 'not a git working tree', foreignDirty: [], branch: null }
  }
  const fixFiles = new Set(repo.fileNames ?? [])
  return {
    repoName: repo.repoName,
    repoRoot,
    ready: true,
    foreignDirty: status.dirtyFiles.map(porcelainPath).filter((p) => !fixFiles.has(p)),
    branch: status.currentBranch,
  }
}
