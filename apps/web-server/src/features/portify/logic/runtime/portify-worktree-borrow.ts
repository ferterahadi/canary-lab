import path from 'path'
import type { FeatureConfig, PortSlot } from '../../../../../../../shared/launcher/types'
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
  /** The slots the sibling declared for this repo. The patch makes the source
   *  read these env vars; declaring them is the half that does NOT travel with
   *  the patch, so they ride along as a hint. Empty on legacy overlays. */
  ports: PortSlot[]
}

/** One group's borrow, recorded for the prompt/instructions note. */
export interface SeededFrom {
  feature: string
  repos: string[]
  /** Slots the source feature declared — see {@link BorrowCandidate.ports}. */
  ports: PortSlot[]
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
      list.push({ feature: f.name, patch, baseSha: repo.baseSha, capturedAt: overlay.meta.capturedAt, ports: repo.ports ?? [] })
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
export function buildSeededNote(seededFrom: SeededFrom[]): string | undefined {
  if (seededFrom.length === 0) return undefined
  const from = seededFrom.map((s) => `"${s.feature}" (${s.repos.join(', ')})`).join('; ')
  const note = `NOTE: the same app was already port-ified for another feature, so its port-injection patch from ${from} has been PRE-APPLIED to the worktree source — the listeners likely already read injected ports. Review the existing edits; you may only need to declare the matching \`ports\` slots in the feature config. A no-op source change is fine — the concurrent double-boot is what proves it.`
  const declared = describeSeededSlots(seededFrom)
  return declared ? `${note}\n\n${declared}` : note
}

/**
 * The slot list the source feature declared for the seeded repos, rendered for
 * the prompt. This is the half of the rewrite the patch does NOT carry, so
 * handing it over is what turns a borrow into "confirm these" instead of
 * "re-derive them from the diff". Deliberately framed as a starting point, not
 * a fact: this feature may boot the same repo a DIFFERENT way (a command that
 * exposes a listener the source feature never booted), and only the double-boot
 * can settle that.
 */
export function describeSeededSlots(seededFrom: SeededFrom[]): string | undefined {
  const lines: string[] = []
  for (const s of seededFrom) {
    for (const slot of s.ports) {
      const decl = slot.env ? `{ name: '${slot.name}', env: '${slot.env}' }` : `{ name: '${slot.name}' }`
      lines.push(`  - \`${decl}\`  (repo: ${s.repos.join(', ')})`)
    }
  }
  if (lines.length === 0) return undefined
  return (
    'The source feature declared these `ports` slots for the seeded repo(s) — the patched source reads exactly these env vars, ' +
    'so START from this list rather than re-deriving it from the diff:\n' +
    lines.join('\n') +
    '\nConfirm each one against the start command(s) THIS feature boots, and add a slot for any listener those commands expose ' +
    'that is missing here — a differently-booted stack can bind a port the source feature never did.'
  )
}

/**
 * True when the seed left the client NOTHING to write: the borrowed patch
 * already makes the source read injected ports, and this feature already
 * declares every env var those slots name. Matched on `env` — that is what the
 * patched source actually reads; slot NAMES are each config's own handle and
 * may legitimately differ between features.
 *
 * Deliberately strict: a legacy overlay records no slots, so this is false and
 * the client edits exactly as before. It gates only whether canary starts the
 * double-boot itself — the boot is still the sole proof either way.
 */
export function seededSlotsAlreadyDeclared(seededFrom: SeededFrom[], declared: PortSlot[]): boolean {
  const wanted = seededFrom.flatMap((s) => s.ports).map((p) => p.env).filter((e): e is string => Boolean(e))
  if (wanted.length === 0) return false
  const have = new Set(declared.map((p) => p.env).filter(Boolean))
  return wanted.every((e) => have.has(e))
}

/** Prepended to the external instructions when canary started the double-boot
 *  itself (see {@link seededSlotsAlreadyDeclared}) — the client must poll, not
 *  edit-and-submit, or it fights a verification already in flight. */
export const SEEDED_AUTO_VERIFY_NOTE =
  'NOTE: nothing to edit. The same app was already port-ified for another feature, its patch is PRE-APPLIED to the ' +
  'worktree, and this feature already declares every matching `ports` slot — so the concurrent double-boot that proves ' +
  'it is ALREADY RUNNING. Do NOT edit the worktree and do NOT call submit_external_portify (it returns 409 while the ' +
  'boot is in flight). Poll get_portify instead: `ready-to-save` means you are done — call save_portify. `editing` means ' +
  'the boot did NOT pass; `verification.failureDetail` says why, and you then fix the worktree and submit as usual.'

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
