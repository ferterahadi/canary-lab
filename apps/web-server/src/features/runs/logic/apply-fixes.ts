import fs from 'fs'
import { resolveRepoPath, runGit } from '../../../shared/git-repo'
import type { RunFixCapture } from '../../../../../../shared/run-state'

// Apply a run's captured heal-fix patches (see RunFixCapture) INTO the real
// product repos on demand — the one place a run's edits reach the user's source
// tree, and only when they ask. Each repo's patch is applied 3-way so it lands
// even against a working tree that drifted a little since the run; a patch that
// won't merge cleanly is reported per-repo rather than aborting the others.

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
 */
export async function applyFixCapture(fixCapture: RunFixCapture): Promise<ApplyFixesOutcome> {
  const results: ApplyFixResult[] = []
  for (const repo of fixCapture.repos) {
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
