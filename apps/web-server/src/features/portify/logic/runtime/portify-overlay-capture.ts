import fs from 'fs'
import { runGit } from '../../../../shared/git-repo'
import { captureDiff, changedFiles } from './git-ops'
import { captureTouchedFiles, type OverlayRepoInput } from './overlay'
import type { ActiveWorkflow } from './runner'

export function readFileOrNull(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8') } catch { return null }
}

// One captured diff per git-root group; every member repo in the group shares
// that group's worktree (so the same patch + base SHA). Run time forces one
// worktree per repo NAME and applies the repo's patch into it.
export async function captureOverlayRepos(state: ActiveWorkflow): Promise<OverlayRepoInput[]> {
  const overlayRepos: OverlayRepoInput[] = []
  for (const group of state.groups) {
    const wt = group.handle! // reaching a capture means setup fully succeeded
    const patch = await captureDiff(wt.worktreeRoot, group.snapshotRef)
    const baseSha = (await runGit(wt.worktreeRoot, ['rev-parse', 'HEAD'])).stdout.trim()
    const changed = await changedFiles(wt.worktreeRoot, group.snapshotRef)
    const touchedFiles = await captureTouchedFiles(wt.worktreeRoot, baseSha, changed)
    for (const member of group.members) {
      overlayRepos.push({ name: member.name, baseSha, patch, touchedFiles })
    }
  }
  return overlayRepos
}

/** The restart-survival capture persisted at every verified ready-to-save park. */
export interface PendingOverlayCapture {
  version: 1
  capturedAt: string
  repos: OverlayRepoInput[]
  originalConfig: string | null
}

export function readPendingOverlay(p: string): PendingOverlayCapture | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as PendingOverlayCapture
    return Array.isArray(parsed.repos) ? parsed : null
  } catch { return null }
}

export function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p) } catch { return p }
}

export function restoreConfig(state: ActiveWorkflow): void {
  if (state.originalConfig == null) return
  try { fs.writeFileSync(state.configPath, state.originalConfig) } catch { /* best-effort */ }
}

// Diff of the canonical feature config edited in place (a different git root
// than the product repo for external features). Empty when not a git repo.
export async function canonicalConfigDiff(featureDir: string, ref: string): Promise<string> {
  const res = await runGit(featureDir, ['diff', ref, '--', 'feature.config.cjs'])
  return res.code === 0 ? res.stdout : ''
}
