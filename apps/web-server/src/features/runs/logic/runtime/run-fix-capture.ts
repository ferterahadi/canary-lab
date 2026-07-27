// Capturing what a heal agent actually changed, and the per-run worktree setup
// that makes that capture honest: the pre-boot stash baseline, the envset
// hydration, and the ephemeral portify overlay applied and reversed around the
// run. Split out of orchestrator.ts; the bodies are unchanged.
import { type RunContext } from './run-context'
import fs from 'fs'
import path from 'path'
import { type RunFixCapture } from '../../../../../../../shared/run-state'
import { resolvePortTokens } from './launcher/interpolate'
import { hydrateEnvsetIntoWorktrees } from './env-switcher/worktree-hydrate'
import { overlayExists, readOverlay, checkStaleness, overlayDir } from '../../../portify/logic/runtime/overlay'
import { applyOverlay, reverseOverlay } from '../../../portify/logic/runtime/git-ops'
import {
diffContentSinceSnapshot,
diffNamesSinceSnapshot,
runGit,
snapshotWorkingTree,
} from '../../../../shared/git-repo'
import { listUntracked, sanitizeRepoFileName } from './repo-worktree'

/** Stash-create a baseline ref for every per-run worktree so teardown can diff
 *  the agent's edits out. Best-effort: a repo we can't snapshot simply won't
 *  have its fix captured — never blocks the boot. */
export async function captureFixBaseline(ctx: RunContext): Promise<void> {
  for (const handle of ctx.worktreeHandles) {
    const ref = await snapshotWorkingTree(handle.worktreeRoot)
    if (ref === null) continue
    const head = await runGit(handle.worktreeRoot, ['rev-parse', 'HEAD'])
    const baseSha = head.code === 0 ? head.stdout.trim() : ''
    ctx.fixBaselines.set(handle.repoName, {
      ref,
      worktreeRoot: handle.worktreeRoot,
      sourceRoot: handle.sourceRoot,
      baseSha,
      untracked: await listUntracked(handle.worktreeRoot),
    })
  }
}

/** Diff each worktree against its capture baseline and persist the heal fix as
 *  `<runDir>/fixes/<repo>.patch` + `fixes.json` + `manifest.fixCapture`. Called
 *  at teardown BEFORE the worktrees are removed. A run whose agent changed
 *  nothing writes no capture. Intent-to-add stages agent-created files so new
 *  source files ride the patch too; gitignored/untracked-at-baseline state
 *  (envset .env, hydrated WIP) never leaks in — the baseline already had it or
 *  git ignores it. */
export async function captureFixes(ctx: RunContext): Promise<void> {
  if (ctx.fixBaselines.size === 0) return
  const repos: RunFixCapture['repos'] = []
  for (const [repoName, base] of ctx.fixBaselines) {
    // Stage ONLY agent-created files (untracked now, but not at baseline) so
    // `git diff <ref>` includes their content — the hydrated WIP / generated
    // docs that were already untracked at baseline stay untracked and never
    // leak into the fix patch.
    const nowUntracked = await listUntracked(base.worktreeRoot)
    const agentNew = [...nowUntracked].filter((f) => !base.untracked.has(f))
    if (agentNew.length > 0) await runGit(base.worktreeRoot, ['add', '-N', '--', ...agentNew])
    const patch = await diffContentSinceSnapshot(base.worktreeRoot, base.ref)
    if (!patch.trim()) continue
    const names = await diffNamesSinceSnapshot(base.worktreeRoot, base.ref)
    const patchFile = `${sanitizeRepoFileName(repoName)}.patch`
    const patchPath = path.join(ctx.paths.fixesDir, patchFile)
    try {
      fs.mkdirSync(ctx.paths.fixesDir, { recursive: true })
      fs.writeFileSync(patchPath, patch)
    } catch (err) {
      ctx.runnerLog?.warn(`Fix capture write failed for "${repoName}": ${(err as Error).message}`)
      continue
    }
    repos.push({ repoName, patchPath, patchFile, repoRoot: base.sourceRoot, baseSha: base.baseSha, files: names.length })
  }
  if (repos.length === 0) return
  const fixCapture: RunFixCapture = { repos, capturedAt: new Date().toISOString() }
  try {
    fs.writeFileSync(path.join(ctx.paths.fixesDir, 'fixes.json'), JSON.stringify(fixCapture, null, 2) + '\n')
  } catch { /* the manifest carries the same data — index file is a convenience */ }
  ctx.stateSink.patchManifest(ctx.runId, { fixCapture })
  ctx.runnerLog?.info(`Captured heal fix diff for ${repos.map((r) => r.repoName).join(', ')} → ${ctx.paths.fixesDir}`)
}

/** Hydrate the feature's envset into every per-run worktree (portified or
 *  collision-isolated). `${port.*}` tokens follow the run's allocation,
 *  byte-identical to the real-path apply. No restore — per-run worktrees are
 *  disposable. No-op without an env, worktrees, or an envsets config. */
export function hydrateWorktreeEnvsets(ctx: RunContext): void {
  if (!ctx.env || ctx.worktreeHandles.length === 0) return
  const { written } = hydrateEnvsetIntoWorktrees({
    featureDir: ctx.feature.featureDir,
    setName: ctx.env,
    roots: ctx.worktreeHandles.map((h) => ({ sourceRoot: h.sourceRoot, worktreeRoot: h.worktreeRoot })),
    resolve: ctx.portMap && ctx.portMap.size > 0
      ? (content) => resolvePortTokens(content, ctx.portMap!)
      : undefined,
  })
  for (const f of written) {
    ctx.runnerLog?.info(`Hydrated envset "${ctx.env}" into worktree: ${f}`)
  }
}

/**
 * Apply the feature's saved port overlay into each per-run worktree. No-op
 * unless the feature is portified. Checks staleness first (the user's repo
 * may have moved since the overlay was captured) and fails loud — with an
 * actionable "re-run Portify" message — on staleness, a missing worktree, or
 * a patch that won't apply. Records what it applied for reverse at teardown.
 */
export async function applyPortifyOverlay(ctx: RunContext): Promise<void> {
  if (!ctx.portified) return
  const featureDir = ctx.feature.featureDir
  const overlay = readOverlay(featureDir)
  if (!overlay) {
    // overlayExists was true at construction but the overlay is now
    // unreadable (e.g. a patch file vanished) — refuse rather than boot bare.
    throw new Error(
      `saved port overlay for "${ctx.feature.name}" is missing or corrupt — re-run Portify to refresh it`,
    )
  }
  // Worktree must cover every overlay repo; otherwise a service would boot
  // from un-patched source. Map repo name → its per-run worktree root.
  const worktreeByRepo: Record<string, string> = {}
  for (const handle of ctx.worktreeHandles) worktreeByRepo[handle.repoName] = handle.worktreeRoot
  const sourceByRepo: Record<string, string> = {}
  for (const repo of overlay.meta.repos) {
    const handle = ctx.worktreeHandles.find((h) => h.repoName === repo.name)
    if (!handle) {
      throw new Error(
        `portified run requires a per-run worktree for repo "${repo.name}" but none was created — this run cannot apply its port overlay safely`,
      )
    }
    sourceByRepo[repo.name] = handle.sourceRoot
  }

  // Staleness: did the user's repo move under the captured patch?
  const staleness = await checkStaleness(featureDir, sourceByRepo)
  if (staleness.stale) {
    const files = staleness.changedFiles.map((c) => `${c.repo}:${c.path}`).join(', ')
    throw new Error(
      `saved port overlay no longer applies (${files} changed since capture) — re-run Portify to refresh it`,
    )
  }

  const dir = overlayDir(featureDir)
  for (const repo of overlay.meta.repos) {
    const worktreeRoot = worktreeByRepo[repo.name]
    const patchPath = path.join(dir, repo.patch)
    const outcome = await applyOverlay(worktreeRoot, patchPath)
    if (outcome.kind === 'ok') {
      ctx.appliedOverlays.push({ repoName: repo.name, worktreeRoot, patchPath })
      ctx.runnerLog?.info(`Applied port overlay for "${repo.name}".`)
      continue
    }
    // Apply failed — reverse whatever already landed, then abort loud.
    await reversePortifyOverlay(ctx)
    const detail = outcome.kind === 'conflict' ? `conflicts in ${outcome.files.join(', ')}` : outcome.detail
    throw new Error(
      `failed to apply the saved port overlay for "${repo.name}" (${detail}) — re-run Portify to refresh it`,
    )
  }
}

/**
 * Reverse every overlay this run applied (`git apply -R`), keeping the
 * worktree intact — it holds the heal agent's repair edits. Reverse is atomic
 * per repo: a conflict (a heal edit on the same lines) leaves that file
 * untouched and is surfaced as a warning, not a throw.
 */
export async function reversePortifyOverlay(ctx: RunContext): Promise<void> {
  for (const applied of ctx.appliedOverlays.splice(0)) {
    const outcome = await reverseOverlay(applied.worktreeRoot, applied.patchPath)
    if (outcome.kind === 'ok') {
      ctx.runnerLog?.info(`Reverted port overlay for "${applied.repoName}".`)
    } else {
      const detail = outcome.kind === 'conflict' ? outcome.files.join(', ') : outcome.detail
      ctx.runnerLog?.warn(
        `port overlay for "${applied.repoName}" could not be reverted (${detail}) — heal edits preserved; the worktree keeps the injected ports`,
      )
    }
  }
}
