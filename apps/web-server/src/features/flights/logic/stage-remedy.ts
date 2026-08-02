import path from 'path'
import { parsePorcelainStatus, runGit } from '../../../shared/git-repo'
import type { FlightManifest, FlightStageRemedy } from '../../../../../../shared/flights/types'

// A failed stage's `error` is a persisted string; the fix for the common
// preflight failures is machine-runnable. This module is the ONE home for that
// mapping (web route + MCP get_flight both call it): match the signature, then
// re-check `git status` LIVE so the remedy always reflects the repos as they
// are now — an old error naming one repo still yields every currently-dirty
// repo, and repos the user cleaned by hand drop off without any state to sync.

const DIRTY_SIGNATURE = /uncommitted changes/

/** The failed stage whose error a remedy could address, if any. */
function failedStageWithDirtySignature(manifest: FlightManifest) {
  return manifest.stages.find((s) => s.status === 'failed' && s.error && DIRTY_SIGNATURE.test(s.error))
}

/** Compute the remedy for a flight, or null when nothing is actionable (no
 *  matching failed stage, or every repo is clean again — the caller renders
 *  "just Continue" for the latter by checking `repos.length === 0`). */
export async function flightStageRemedy(manifest: FlightManifest): Promise<FlightStageRemedy | null> {
  const stage = failedStageWithDirtySignature(manifest)
  if (!stage) return null
  const repos: FlightStageRemedy['repos'] = []
  for (const repoPath of manifest.repoPaths) {
    const status = await runGit(repoPath, ['status', '--porcelain', '--', '.'])
    if (status.code !== 0) continue // not a git repo (or gone) — nothing to stash
    const modified = parsePorcelainStatus(status.stdout).length
    if (modified > 0) repos.push({ name: path.basename(repoPath), path: repoPath, modified })
  }
  return { kind: 'dirty-repos', stage: stage.key, repos, actions: ['stash', 'commit'] }
}

export interface RemedyApplyResult {
  action: 'stash' | 'commit'
  /** Repo paths actually cleaned (already-clean ones are skipped). */
  cleaned: string[]
}

/** Execute the remedy: clean every currently-dirty repo. Idempotent — a repo
 *  that is clean by the time we get to it is skipped, so a partial failure is
 *  recoverable by clicking again. Throws on the first repo whose git command
 *  fails (the remainder stays dirty and the next read re-lists it). */
export async function applyFlightStageRemedy(
  manifest: FlightManifest,
  action: 'stash' | 'commit',
): Promise<RemedyApplyResult> {
  const remedy = await flightStageRemedy(manifest)
  if (!remedy) throw Object.assign(new Error('no remedy applies to this flight'), { statusCode: 409 })
  const cleaned: string[] = []
  for (const repo of remedy.repos) {
    // Every argv ends in `-- .` so the sweep matches the count. A feature repo
    // is often a SUBDIRECTORY of a much larger git root (the whole workspace,
    // when a feature points at a folder beside `features/`), and both the
    // count above and portify's own gate are scoped with `-- .`. Without the
    // pathspec, `add -A` / `stash push -u` run from any subdirectory take the
    // entire root — so a button reading "2 modified" would commit or stash
    // every unrelated dirty file in the workspace.
    const argvs = action === 'stash'
      ? [['stash', 'push', '-u', '-m', `canary-lab: pre-flight stash (${manifest.flightId})`, '--', '.']]
      : [['add', '-A', '--', '.'], ['commit', '-m', 'canary-lab: wip', '--', '.']]
    for (const argv of argvs) {
      const r = await runGit(repo.path, argv)
      if (r.code !== 0) {
        throw Object.assign(
          new Error(`git ${argv[0]} failed in "${repo.name}": ${(r.stderr || r.stdout).trim()}`),
          { statusCode: 500 },
        )
      }
    }
    cleaned.push(repo.path)
  }
  return { action, cleaned }
}
