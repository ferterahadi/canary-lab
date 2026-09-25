// Capturing what a heal agent actually changed, and the per-run worktree setup
// that makes that capture honest: the pre-boot stash baseline, the envset
// hydration, and the ephemeral portify overlay applied and reversed around the
// run. Split out of orchestrator.ts; the bodies are unchanged.
import { type RunContext } from './run-context'
import { readManifest } from './manifest'
import fs from 'fs'
import path from 'path'
import { FIX_CAPTURE_MAX_FILE_NAMES, type RunFixCapture } from '../../../../../../../shared/run-state'
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
    // The stash probe is what makes an unreadable tree safe: it fails on
    // exactly the cases that would also break the untracked listing, so a repo
    // git cannot describe gets no baseline and therefore no capture — rather
    // than an empty baseline that would file every pre-existing file as the
    // agent's work.
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
 *  while healing and at teardown BEFORE the worktrees are removed. A run whose agent changed
 *  nothing writes no capture. Intent-to-add stages agent-created files so new
 *  source files ride the patch too; gitignored/untracked-at-baseline state
 *  (envset .env, hydrated WIP) never leaks in — the baseline already had it or
 *  git ignores it. */
export async function captureFixes(ctx: RunContext, provisional = false): Promise<RunFixCapture | null> {
  if (ctx.fixBaselines.size === 0) return null
  // No heal cycle, no repair to capture. Teardown runs this for EVERY worktree
  // run, so without this gate anything a worktree accumulated on its own — a
  // file a booted service wrote, a stray untracked path the baseline could not
  // see — is filed as an agent's fix, and the Changes tab then offers to open a
  // pull request for it. `noteHealCycle` fires at the top of both heal loops
  // (local and external), so a genuine repair always carries at least one.
  // Same predicate `shouldAutoPropose` already uses for "a repair happened".
  if (ctx.healCycles <= 0) return null
  const previous = readManifest(ctx.paths.manifestPath)?.fixCapture
  const repos: RunFixCapture['repos'] = []
  let patchChanged = false
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
      if (!fs.existsSync(patchPath) || fs.readFileSync(patchPath, 'utf8') !== patch) {
        const pendingPath = `${patchPath}.tmp`
        fs.writeFileSync(pendingPath, patch)
        fs.renameSync(pendingPath, patchPath)
        patchChanged = true
      }
    } catch (err) {
      ctx.runnerLog?.warn(`Fix capture write failed for "${repoName}": ${(err as Error).message}`)
      continue
    }
    repos.push({
      repoName,
      patchPath,
      patchFile,
      repoRoot: base.sourceRoot,
      baseSha: base.baseSha,
      files: names.length,
      // `files` stays the true count; the list is what lets the Changes tab
      // say WHICH files, so the user can pick them out of their own editor's
      // changed-files list after the patch lands in the real repo.
      fileNames: names.slice(0, FIX_CAPTURE_MAX_FILE_NAMES),
    })
  }
  if (repos.length === 0) {
    if (previous?.provisional) {
      ctx.stateSink.patchManifest(ctx.runId, { fixCapture: undefined })
      for (const repo of previous.repos) removeStalePatch(ctx, repo.patchFile)
      removeStalePatch(ctx, 'fixes.json')
    }
    return null
  }
  if (previous && !patchChanged && previous.provisional === (provisional || undefined)
    && JSON.stringify(previous.repos) === JSON.stringify(repos)) return previous
  const fixCapture: RunFixCapture = {
    repos,
    capturedAt: new Date().toISOString(),
    ...(provisional ? { provisional: true } : {}),
  }
  try {
    const indexPath = path.join(ctx.paths.fixesDir, 'fixes.json')
    fs.writeFileSync(`${indexPath}.tmp`, JSON.stringify(fixCapture, null, 2) + '\n')
    fs.renameSync(`${indexPath}.tmp`, indexPath)
  } catch { /* the manifest carries the same data — index file is a convenience */ }
  ctx.stateSink.patchManifest(ctx.runId, { fixCapture })
  for (const repo of previous?.repos ?? []) {
    if (!repos.some((current) => current.repoName === repo.repoName)) {
      removeStalePatch(ctx, repo.patchFile)
    }
  }
  if (!provisional) ctx.runnerLog?.info(`Captured heal fix diff for ${repos.map((r) => r.repoName).join(', ')} → ${ctx.paths.fixesDir}`)
  return fixCapture
}

function removeStalePatch(ctx: RunContext, file: string): void {
  try {
    fs.rmSync(path.join(ctx.paths.fixesDir, path.basename(file)), { force: true })
  } catch (err) {
    ctx.runnerLog?.warn(`Stale fix patch cleanup failed: ${(err as Error).message}`)
  }
}

/** File events make edits visible promptly; reconciliation catches missed
 *  events and newly created directories. Both read the same worktree baseline
 *  as teardown, and the manifest write publishes through RunStore to open UIs. */
export function startLiveFixCapture(ctx: RunContext, opts: {
  watchPath?: (root: string, listener: fs.WatchListener<string>) => fs.FSWatcher
  debounceMs?: number
  reconcileMs?: number
} = {}): { close(): Promise<void> } {
  const watchers: fs.FSWatcher[] = []
  let closed = false
  let timer: NodeJS.Timeout | null = null
  let inFlight: Promise<void> | null = null
  let rescan = false

  const scan = (): void => {
    timer = null
    if (closed || ctx.healCycles <= 0) return
    if (inFlight) { rescan = true; return }
    inFlight = captureFixes(ctx, true)
      .then(() => {})
      .catch((err) => ctx.runnerLog?.warn(`Live fix capture failed: ${(err as Error).message}`))
      .finally(() => {
        inFlight = null
        if (rescan && !closed) { rescan = false; schedule() }
      })
  }
  const schedule = (): void => {
    if (closed || timer) return
    timer = setTimeout(scan, opts.debounceMs ?? 150)
    timer.unref()
  }
  const watchPath = opts.watchPath ?? ((root: string, listener: fs.WatchListener<string>) => (
    fs.watch(root, { recursive: true, persistent: false }, listener)
  ))
  for (const base of ctx.fixBaselines.values()) {
    try {
      const watcher = watchPath(base.worktreeRoot, (_event, name) => {
        if (name && /^(?:\.git|node_modules)(?:[\\/]|$)/.test(String(name))) return
        schedule()
      })
      watcher.on('error', (err) => ctx.runnerLog?.warn(`Live fix watcher failed: ${err.message}`))
      watchers.push(watcher)
    } catch (err) {
      ctx.runnerLog?.warn(`Live fix watcher failed: ${(err as Error).message}`)
    }
  }
  const reconcile = setInterval(schedule, opts.reconcileMs ?? 2_000)
  reconcile.unref()
  return {
    async close(): Promise<void> {
      closed = true
      clearInterval(reconcile)
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) {
        try { watcher.close() } catch (err) {
          ctx.runnerLog?.warn(`Live fix watcher close failed: ${(err as Error).message}`)
        }
      }
      await inFlight
    },
  }
}

/** Hydrate the feature's envset into every per-run worktree (portified or
 *  collision-isolated). `${port.*}` tokens follow the run's allocation,
 *  byte-identical to the real-path apply. No restore — per-run worktrees are
 *  disposable. No-op without an env, worktrees, or an envsets config. */
export function hydrateWorktreeEnvsets(ctx: RunContext): void {
  if (!ctx.env || ctx.worktreeHandles.length === 0) return
  const clientPorts = ctx.portMap
  const { written } = hydrateEnvsetIntoWorktrees({
    featureDir: ctx.feature.featureDir,
    setName: ctx.env,
    roots: ctx.worktreeHandles.map((h) => ({ sourceRoot: h.sourceRoot, worktreeRoot: h.worktreeRoot })),
    resolve: clientPorts && clientPorts.size > 0
      ? (content) => resolvePortTokens(content, clientPorts)
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
