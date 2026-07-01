import fs from 'fs'
import path from 'path'
import { loadFeatures } from '../../../config/logic/feature-loader'
import { getGitRoot } from '../../../../shared/git-repo'
import type { DirtySpecStore } from './store'

// Live recompute trigger for test-file integrity. fs.watch on each feature's
// `e2e/` dir fires the instant a spec is saved; a watch on each repo's `.git`
// dir catches commits (so committing a change clears the cue without waiting for
// the next run). The watch event is ONLY a "recompute now" trigger — the truth
// is always the content hash the store computes, never the fs event itself.

export interface DirtySpecWatcher {
  close(): void
}

interface WatcherDeps {
  featuresDir: string
  store: DirtySpecStore
  /** Debounce window; coalesces editor save-storms into one recompute. */
  debounceMs?: number
  log?: (msg: string, err?: unknown) => void
  /** Fired (debounced, same window as recompute) when a spec file's content
   *  actually changed on disk — NOT when only a commit triggered the recompute.
   *  Lets the server also publish `tests-changed`, so a viewer showing spec
   *  source (e.g. the expanded test body) refetches live instead of only the
   *  dirty flag updating. */
  onSpecFileChanged?: (featureName: string) => void
}

export function startDirtySpecWatcher(deps: WatcherDeps): DirtySpecWatcher {
  const debounceMs = deps.debounceMs ?? 250
  const watchers: fs.FSWatcher[] = []
  const timers = new Map<string, NodeJS.Timeout>()
  // Features with a pending content change (from the e2e-dir watch, not the
  // .git one) whose debounce timer hasn't fired yet — checked-and-cleared when
  // the timer runs so a save + commit inside one debounce window still only
  // fires onSpecFileChanged once.
  const pendingContentChange = new Set<string>()
  let closed = false

  const scheduleRecompute = (featureName: string, featureDir: string): void => {
    if (closed) return
    const existing = timers.get(featureName)
    if (existing) clearTimeout(existing)
    timers.set(
      featureName,
      setTimeout(() => {
        timers.delete(featureName)
        deps.store.recompute(featureName, featureDir).catch((err) => deps.log?.('dirty-spec recompute failed', err))
        if (pendingContentChange.delete(featureName)) deps.onSpecFileChanged?.(featureName)
      }, debounceMs),
    )
  }

  const features = loadFeatures(deps.featuresDir)
  // featureDirs sharing one git root (the usual case: all features in the
  // workspace repo) → recompute every member when that repo's .git changes.
  const byGitRoot = new Map<string, { name: string; dir: string }[]>()

  for (const feature of features) {
    const featureDir = feature.featureDir
    if (typeof featureDir !== 'string' || featureDir.length === 0) continue
    // Initial recompute so the feature list has a dirty status to read on cold load.
    deps.store.recompute(feature.name, featureDir).catch((err) => deps.log?.('initial dirty-spec recompute failed', err))

    const e2eDir = path.join(featureDir, 'e2e')
    if (fs.existsSync(e2eDir)) {
      try {
        const w = fs.watch(e2eDir, { persistent: false }, (_event, filename) => {
          // null filename (some platforms) → recompute anyway; otherwise only specs.
          if (filename && !String(filename).endsWith('.spec.ts')) return
          pendingContentChange.add(feature.name)
          scheduleRecompute(feature.name, featureDir)
        })
        watchers.push(w)
      } catch (err) {
        deps.log?.('failed to watch feature e2e dir', err)
      }
    }

    void getGitRoot(featureDir).then((root) => {
      if (!root) return
      const group = byGitRoot.get(root) ?? []
      group.push({ name: feature.name, dir: featureDir })
      byGitRoot.set(root, group)
      if (group.length === 1) watchGitDir(root)
    })
  }

  function watchGitDir(gitRoot: string): void {
    const gitDir = path.join(gitRoot, '.git')
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return
    try {
      // Non-recursive: a commit rewrites .git/index + COMMIT_EDITMSG (direct
      // children), enough to trigger; recompute is idempotent so over-firing on
      // `git add` is harmless. Recompute every feature under this root.
      const w = fs.watch(gitDir, { persistent: false }, () => {
        for (const f of byGitRoot.get(gitRoot) ?? []) scheduleRecompute(f.name, f.dir)
      })
      watchers.push(w)
    } catch (err) {
      deps.log?.('failed to watch .git dir', err)
    }
  }

  return {
    close() {
      closed = true
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          /* best-effort */
        }
      }
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
}
