import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { resolveRepoPath, getGitRoot } from '../../../../shared/git-repo'
import { type WorktreeHandle } from '../../../runs/logic/runtime/repo-worktree'
import { computeSlotBudget, readSystemResources, resolveAdmissionConfig } from '../../../runs/logic/runtime/admission'
import { readOverlay } from './overlay'

export interface GroupMember {
  name: string
  /** Canonical localPath of this logical repo. */
  path: string
  /** Where to edit this repo's source inside the group's worktree. */
  editPath?: string
}

export interface RepoGroup {
  /** Stable worktree-dir key. */
  key: string
  /** Git toplevel shared by every member. */
  sourceRoot: string
  handle?: WorktreeHandle
  /** Worktree diff baseline captured before the agent edits. */
  snapshotRef: string
  members: GroupMember[]
}

export function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'root'
}

/** A reusable port patch another feature already saved for the same git root. */
export interface BorrowCandidate {
  /** The sibling feature whose overlay this came from. */
  feature: string
  /** Unified diff content to pre-apply into the scratch worktree. */
  patch: string
  /** HEAD the sibling captured the patch against (prefer an exact match). */
  baseSha: string
  /** ISO capture time — newest wins when several siblings match. */
  capturedAt: string
}

/**
 * Index every OTHER feature's saved overlay by the git root its patch targets,
 * so a new port-ification can borrow an existing rewrite for the same app
 * instead of redoing it. Skips empty (source-native) overlays — there's nothing
 * to apply. Resolving a sibling repo's git root requires the same path dance as
 * setup (resolveRepoPath → getGitRoot).
 */
export async function buildSiblingOverlayIndex(
  features: FeatureConfig[],
  currentFeature: string,
): Promise<Map<string, BorrowCandidate[]>> {
  const index = new Map<string, BorrowCandidate[]>()
  for (const f of features) {
    if (f.name === currentFeature) continue
    const overlay = readOverlay(f.featureDir)
    if (!overlay) continue
    for (const repo of overlay.meta.repos) {
      const patch = overlay.patches[repo.name]
      if (!patch || !patch.trim()) continue // source-native overlay — nothing to borrow
      const decl = (f.repos ?? []).find((r) => r.name === repo.name)
      if (!decl) continue
      let root: string | null = null
      try { root = await getGitRoot(resolveRepoPath(decl.localPath)) } catch { /* unresolved repo — skip */ }
      if (!root) continue
      const list = index.get(root) ?? []
      list.push({ feature: f.name, patch, baseSha: repo.baseSha, capturedAt: overlay.meta.capturedAt })
      index.set(root, list)
    }
  }
  return index
}

/**
 * Note for the agent/client when sibling overlays were pre-applied to the
 * worktree — so it reviews the existing edits + declares config slots instead
 * of rewriting from scratch (and isn't surprised by a populated tree).
 */
export function buildSeededNote(seededFrom: { feature: string; repos: string[] }[]): string | undefined {
  if (seededFrom.length === 0) return undefined
  const from = seededFrom.map((s) => `"${s.feature}" (${s.repos.join(', ')})`).join('; ')
  return `NOTE: the same app was already port-ified for another feature, so its port-injection patch from ${from} has been PRE-APPLIED to the worktree source — the listeners likely already read injected ports. Review the existing edits; you may only need to declare the matching \`ports\` slots in the feature config. A no-op source change is fine — the concurrent double-boot is what proves it.`
}

/** Pick the best sibling patch for a root: exact base-SHA match first, then newest. */
export function pickBorrowable(candidates: BorrowCandidate[] | undefined, baseSha: string): BorrowCandidate | null {
  if (!candidates || candidates.length === 0) return null
  return [...candidates].sort(
    (a, b) =>
      Number(b.baseSha === baseSha) - Number(a.baseSha === baseSha) ||
      b.capturedAt.localeCompare(a.capturedAt),
  )[0]
}

/**
 * Max port-ification workflows allowed to run CONCURRENTLY (across all
 * features). The per-feature lock already prevents two workflows on one feature;
 * this caps the global load because each `submit_external_portify` boots the
 * whole stack TWICE concurrently to verify, so unbounded fan-out across features
 * would exhaust the machine. Reuses the run loop's resource heuristic
 * (`computeSlotBudget`) rather than a bespoke number; `CANARY_MAX_CONCURRENT_PORTIFY`
 * is the optional manual ceiling (mirrors `CANARY_MAX_CONCURRENT_RUNS`).
 */
export function portifyConcurrencyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CANARY_MAX_CONCURRENT_PORTIFY
  if (raw != null && raw.trim() !== '') {
    const n = Number.parseInt(raw.trim(), 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return computeSlotBudget(readSystemResources(), resolveAdmissionConfig(env))
}
