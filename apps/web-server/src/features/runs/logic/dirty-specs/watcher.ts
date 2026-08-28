import fs from 'fs'
import path from 'path'
import { loadFeatures } from '../../../../shared/feature-loader'
import { getGitRoot } from '../../../../shared/git-repo'
import type { DirtySpecStore } from './store'

// Live recompute trigger for test-file integrity. fs.watch on each feature's
// `e2e/` dir fires the instant a spec is saved; a watch on each repo's `.git`
// dir catches commits (so committing a change clears the cue without waiting for
// the next run). The watch event is ONLY a "recompute now" trigger — the truth
// is always the content hash the store computes, never the fs event itself.

export interface DirtySpecWatcher {
  /** Begin the cold integrity scan after the HTTP listener is accepting work. */
  startInitialScan(): Promise<void>
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
  /** Test seam for proving that each suite yields before its scan begins. */
  yieldToEventLoop?: () => Promise<void>
  /** Test seam for delivering filesystem events without depending on the
   *  host's watcher limits or event-coalescing behavior. */
  watchPath?: (
    target: string,
    options: { persistent: boolean },
    listener: fs.WatchListener<string>,
  ) => fs.FSWatcher
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
  const initialFeatures: Array<{ name: string; dir: string }> = []
  const yieldToEventLoop = deps.yieldToEventLoop
    ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
  const watchPath = deps.watchPath ?? ((target, options, listener) => fs.watch(target, options, listener))
  let initialScan: Promise<void> | null = null
  let closed = false

  const trackWatcher = (watcher: fs.FSWatcher, failureMessage: string): void => {
    // fs.watch may fail after construction (macOS reports exhausted FSEvents
    // resources this way). Handle the emitter error as well as the sync throw
    // below so a best-effort integrity watcher can never crash the server.
    watcher.on('error', (err) => deps.log?.(failureMessage, err))
    watchers.push(watcher)
  }

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
    initialFeatures.push({ name: feature.name, dir: featureDir })

    const e2eDir = path.join(featureDir, 'e2e')
    if (fs.existsSync(e2eDir)) {
      try {
        const w = watchPath(e2eDir, { persistent: false }, (_event, filename) => {
          // null filename (some platforms) → recompute anyway; otherwise only specs.
          if (filename && !String(filename).endsWith('.spec.ts')) return
          pendingContentChange.add(feature.name)
          scheduleRecompute(feature.name, featureDir)
        })
        trackWatcher(w, 'failed to watch feature e2e dir')
      } catch (err) {
        deps.log?.('failed to watch feature e2e dir', err)
      }
    }

    void getGitRoot(featureDir).then((root) => {
      if (!root || closed) return
      const group = byGitRoot.get(root) ?? []
      group.push({ name: feature.name, dir: featureDir })
      byGitRoot.set(root, group)
      if (group.length === 1) watchGitDir(root)
    })
  }

  async function scanInitialFeatures(): Promise<void> {
    for (const feature of initialFeatures) {
      // The scan parses and hashes authored specs. Yield before every suite so a
      // large workspace cannot monopolize the event loop after the listener opens.
      await yieldToEventLoop()
      if (closed) return
      try {
        await deps.store.recompute(feature.name, feature.dir)
      } catch (err) {
        deps.log?.('initial dirty-spec recompute failed', err)
      }
    }
  }

  function watchGitDir(gitRoot: string): void {
    const gitDir = path.join(gitRoot, '.git')
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return
    try {
      // Non-recursive: a commit rewrites .git/index + COMMIT_EDITMSG (direct
      // children), enough to trigger; recompute is idempotent so over-firing on
      // `git add` is harmless. Recompute every feature under this root.
      const w = watchPath(gitDir, { persistent: false }, () => {
        // `watchGitDir` only ever runs right after `byGitRoot.set(gitRoot, ...)`
        // with a non-empty group, and entries are never removed, so this is
        // always populated by the time the watch callback can fire.
        for (const f of byGitRoot.get(gitRoot)!) scheduleRecompute(f.name, f.dir)
      })
      trackWatcher(w, 'failed to watch .git dir')
    } catch (err) {
      deps.log?.('failed to watch .git dir', err)
    }
  }

  return {
    startInitialScan() {
      initialScan ??= scanInitialFeatures()
      return initialScan
    },
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
