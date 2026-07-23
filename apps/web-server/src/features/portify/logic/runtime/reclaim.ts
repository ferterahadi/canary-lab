import fs from 'fs'
import path from 'path'
import { getGitRoot, resolveRepoPath, runGit } from '../../../../shared/git-repo'
import { removeWorktree } from '../../../runs/logic/runtime/repo-worktree'
import { buildPortifyPaths, portifyDir } from './paths'
import type { PortifyRunStore } from './store'
import type { PortifyManifest, PortifyStatus } from './types'

// Startup reclaim for port-ification workflows orphaned by a dead process
// (crash, or Ctrl-C of the UI mid-run). The normal exit paths (commit/cancel/
// orchestrator cleanup) run in-process and never fired, so on restart we must:
//   1. remove each orphan's git worktree(s),
//   2. delete its branch from the product repo(s), and
//   3. restore the feature config it edited in place (from the on-disk
//      snapshot — the in-memory original is gone).
// Then flip the manifest to `aborted` so the UI doesn't show a zombie workflow.
//
// EXCEPTION — a parked, verified review survives: a `ready-to-save` workflow
// whose park persisted its overlay capture (pending-overlay.json) stays
// `ready-to-save`. Its worktrees/branch still go (revise needs a live agent
// session and is gone either way), but the config stays portified in place —
// exactly the state it was in while parked live — and `save()` writes the
// overlay from the capture. Aborting these was the old behavior, and it turned
// an already-verified diff into an unanswerable checkpoint (save → 409) every
// time a restart landed while a review sat open.
//
// This supersedes the store's pure-manifest `reconcileInterrupted` at startup;
// it does the disk cleanup the store can't (the store does no git/fs I/O).

const TERMINAL: ReadonlySet<PortifyStatus> = new Set<PortifyStatus>(['saved', 'failed', 'aborted'])

export async function reclaimOrphanedPortify(
  store: PortifyRunStore,
  logsDir: string,
  now: () => string,
): Promise<void> {
  for (const entry of store.list()) {
    if (TERMINAL.has(entry.status)) continue
    const m = store.get(entry.workflowId)
    if (!m) continue
    const { pendingOverlayPath } = buildPortifyPaths(portifyDir(logsDir, m.workflowId))
    if (m.status === 'ready-to-save' && fs.existsSync(pendingOverlayPath)) {
      await removeWorktrees(m)
      continue // stays parked + answerable; config deliberately NOT restored
    }
    await removeWorktrees(m)
    restoreOriginalConfig(m, logsDir)
    store.save({
      ...m,
      status: 'aborted',
      endedAt: m.endedAt ?? now(),
      error: m.error ?? 'Interrupted by server restart',
    })
  }
}

async function removeWorktrees(m: PortifyManifest): Promise<void> {
  // Remove each distinct worktree + delete the shared branch. Repos that share
  // a git root share one worktree, so dedupe by worktreePath.
  const seen = new Set<string>()
  for (const repo of m.repos) {
    if (!repo.worktreePath || seen.has(repo.worktreePath)) continue
    seen.add(repo.worktreePath)
    try {
      const sourceRoot = await getGitRoot(resolveRepoPath(repo.path))
      if (!sourceRoot) continue
      await removeWorktree({ sourceRoot, worktreeRoot: repo.worktreePath })
      await runGit(sourceRoot, ['branch', '-D', m.branch])
    } catch {
      /* best-effort — a missing repo/worktree just stays as-is */
    }
  }
}

// Restore the canonical feature config from the pre-edit snapshot.
function restoreOriginalConfig(m: PortifyManifest, logsDir: string): void {
  try {
    const { originalConfigPath } = buildPortifyPaths(portifyDir(logsDir, m.workflowId))
    if (fs.existsSync(originalConfigPath)) {
      const original = fs.readFileSync(originalConfigPath, 'utf-8')
      fs.writeFileSync(path.join(m.featureDir, 'feature.config.cjs'), original)
    }
  } catch {
    /* best-effort */
  }
}
