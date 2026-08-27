import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDirtySpecWatcher, type DirtySpecWatcher } from './watcher'
import type { DirtySpecStore } from './store'
import * as gitRepo from '../../../../shared/git-repo'

let tmpDir: string
let featuresDir: string

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function writeFeature(name: string, opts: { withE2eDir?: boolean; withGit?: boolean } = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: '${name}', description: 'd', envs: ['local'], featureDir: __dirname } }`,
  )
  if (opts.withE2eDir) {
    fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  }
  if (opts.withGit) {
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.email', 't@t.dev'])
    git(dir, ['config', 'user.name', 'test'])
    fs.writeFileSync(path.join(dir, 'README.md'), 'x')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-q', '-m', 'init'])
  }
  return dir
}

function fakeStore(): { store: DirtySpecStore; recompute: ReturnType<typeof vi.fn> } {
  const recompute = vi.fn().mockResolvedValue(undefined)
  const store = { recompute } as unknown as DirtySpecStore
  return { store, recompute }
}

// Poll for a condition instead of a fixed sleep — fs.watch delivery timing
// varies by platform/CI.
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

type WatcherDeps = Parameters<typeof startDirtySpecWatcher>[0]
type WatchPath = NonNullable<WatcherDeps['watchPath']>

interface FakeWatchControl {
  watchPath: WatchPath
  fire(targetSuffix: string, filename?: string | null): boolean
  listener(targetSuffix: string): fs.WatchListener<string>
}

/** Unit tests deliver registered callbacks directly. macOS can coalesce real
 * directory events, and the developer's running Canary instance legitimately
 * owns many watchers; neither should decide whether debounce logic is tested. */
function createFakeWatchControl(): FakeWatchControl {
  const listeners = new Map<string, Set<fs.WatchListener<string>>>()
  const watchPath: WatchPath = (target, _options, listener) => {
    const targetListeners = listeners.get(target) ?? new Set()
    targetListeners.add(listener)
    listeners.set(target, targetListeners)
    const watcher = new EventEmitter() as fs.FSWatcher
    watcher.close = () => {
      targetListeners.delete(listener)
    }
    return watcher
  }
  return {
    watchPath,
    fire(targetSuffix, filename = 'a.spec.ts') {
      const matched = [...listeners.entries()].filter(([target]) => target.endsWith(targetSuffix))
      matched.forEach(([, targetListeners]) => {
        targetListeners.forEach((listener) => listener('change', filename))
      })
      return matched.some(([, targetListeners]) => targetListeners.size > 0)
    },
    listener(targetSuffix) {
      const targetListeners = [...listeners.entries()].find(([target]) => target.endsWith(targetSuffix))?.[1]
      const listener = targetListeners?.values().next().value
      if (!listener) throw new Error(`no watch listener was registered for ${targetSuffix}`)
      return listener
    },
  }
}

let watcher: DirtySpecWatcher | undefined
let watchControl: FakeWatchControl

function startWatcher(deps: Omit<WatcherDeps, 'watchPath'>): DirtySpecWatcher {
  return startDirtySpecWatcher({ ...deps, watchPath: watchControl.watchPath })
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-watcher-')))
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
  watchControl = createFakeWatchControl()
})

afterEach(() => {
  watcher?.close()
  watcher = undefined
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('startDirtySpecWatcher', () => {
  it('runs an initial recompute for every loaded feature', async () => {
    const dir = writeFeature('alpha')
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir, store })
    await watcher.startInitialScan()
    expect(recompute).toHaveBeenCalledWith('alpha', dir)
  })

  it('does not begin the cold scan until the listener starts it', async () => {
    writeFeature('alpha')
    const { store, recompute } = fakeStore()
    const yieldToEventLoop = vi.fn().mockResolvedValue(undefined)
    watcher = startWatcher({ featuresDir, store, yieldToEventLoop })

    expect(recompute).not.toHaveBeenCalled()
    await watcher.startInitialScan()

    expect(yieldToEventLoop).toHaveBeenCalledTimes(1)
    expect(yieldToEventLoop.mock.invocationCallOrder[0]).toBeLessThan(recompute.mock.invocationCallOrder[0])
  })

  it('yields between suites instead of launching every recompute in one turn', async () => {
    writeFeature('alpha')
    writeFeature('beta')
    const order: string[] = []
    const recompute = vi.fn(async (name: string) => { order.push(name) })
    const store = { recompute } as unknown as DirtySpecStore
    const yieldToEventLoop = vi.fn(async () => { order.push('yield') })
    watcher = startWatcher({ featuresDir, store, yieldToEventLoop })

    await watcher.startInitialScan()

    expect(order).toEqual(['yield', 'alpha', 'yield', 'beta'])
  })

  it('logs when the initial recompute rejects', async () => {
    const recompute = vi.fn().mockRejectedValue(new Error('boom'))
    const store = { recompute } as unknown as DirtySpecStore
    const log = vi.fn()
    writeFeature('alpha')
    watcher = startWatcher({ featuresDir, store, log })
    await watcher.startInitialScan()
    expect(log).toHaveBeenCalledWith('initial dirty-spec recompute failed', expect.any(Error))
  })

  it('skips features with no featureDir string', async () => {
    const dir = path.join(featuresDir, 'bad')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'bad', description: 'd', envs: [] } }`,
    )
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir, store })
    await watcher.startInitialScan()
    expect(recompute).not.toHaveBeenCalledWith('bad', expect.anything())
  })

  it('debounces a spec save in the e2e dir and recomputes after the window', async () => {
    const dir = writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir, store, debounceMs: 200 })
    await watcher.startInitialScan()
    recompute.mockClear()

    expect(watchControl.fire(path.join('alpha', 'e2e'))).toBe(true)
    // A rapid second save inside the debounce window resets the timer, so the
    // recompute only fires once the window elapses from the LAST write.
    await new Promise((r) => setTimeout(r, 20))
    expect(watchControl.fire(path.join('alpha', 'e2e'))).toBe(true)

    // Not yet — still inside the (reset) debounce window.
    await new Promise((r) => setTimeout(r, 50))
    expect(recompute).not.toHaveBeenCalled()

    await waitFor(() => recompute.mock.calls.length >= 1)
    expect(recompute).toHaveBeenCalledWith('alpha', dir)
  })

  it('ignores non-.spec.ts filenames in the e2e dir', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir, store, debounceMs: 20 })
    await watcher.startInitialScan()
    recompute.mockClear()

    expect(watchControl.fire(path.join('alpha', 'e2e'), 'notes.txt')).toBe(true)
    await new Promise((r) => setTimeout(r, 150))
    expect(recompute).not.toHaveBeenCalled()
  })

  it('calls onSpecFileChanged once when a real spec-content change triggers the debounce', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    const onSpecFileChanged = vi.fn()
    watcher = startWatcher({ featuresDir, store, debounceMs: 20, onSpecFileChanged })
    await watcher.startInitialScan()
    recompute.mockClear()

    expect(watchControl.fire(path.join('alpha', 'e2e'))).toBe(true)
    await waitFor(() => onSpecFileChanged.mock.calls.length >= 1)
    expect(onSpecFileChanged).toHaveBeenCalledWith('alpha')
    expect(onSpecFileChanged).toHaveBeenCalledTimes(1)
  })

  it('logs when a debounced recompute rejects', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const recompute = vi
      .fn()
      .mockResolvedValueOnce(undefined) // initial recompute succeeds
      .mockRejectedValue(new Error('recompute broke'))
    const store = { recompute } as unknown as DirtySpecStore
    const log = vi.fn()
    watcher = startWatcher({ featuresDir, store, debounceMs: 20, log })
    await watcher.startInitialScan()
    log.mockClear()

    expect(watchControl.fire(path.join('alpha', 'e2e'))).toBe(true)
    await waitFor(() => log.mock.calls.length >= 1)
    expect(log).toHaveBeenCalledWith('dirty-spec recompute failed', expect.any(Error))
  })

  it('recomputes every feature sharing a git root when the .git dir changes', async () => {
    // Two features living inside the same git repo (nested dirs under one root).
    const repoRoot = path.join(featuresDir, 'repo')
    fs.mkdirSync(repoRoot, { recursive: true })
    git(repoRoot, ['init', '-q'])
    git(repoRoot, ['config', 'user.email', 't@t.dev'])
    git(repoRoot, ['config', 'user.name', 'test'])
    fs.writeFileSync(path.join(repoRoot, 'README.md'), 'x')
    git(repoRoot, ['add', '.'])
    git(repoRoot, ['commit', '-q', '-m', 'init'])

    const aDir = path.join(repoRoot, 'a')
    const bDir = path.join(repoRoot, 'b')
    fs.mkdirSync(aDir, { recursive: true })
    fs.mkdirSync(bDir, { recursive: true })
    fs.writeFileSync(
      path.join(aDir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'a', description: 'd', envs: [], featureDir: __dirname } }`,
    )
    fs.writeFileSync(
      path.join(bDir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'b', description: 'd', envs: [], featureDir: __dirname } }`,
    )
    // loadFeatures scans featuresDir's direct children, so point featuresDir at repoRoot.
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir: repoRoot, store, debounceMs: 20 })
    await watcher.startInitialScan()
    // getGitRoot resolves asynchronously (a real `git` subprocess call); give the
    // .git watch registration time to land before clearing and asserting on it.
    await new Promise((r) => setTimeout(r, 300))
    recompute.mockClear()

    // Simulate a commit touching .git's direct children.
    expect(watchControl.fire('.git', 'COMMIT_EDITMSG')).toBe(true)

    await waitFor(() => recompute.mock.calls.length >= 2, 6000)
    const names = recompute.mock.calls.map((c) => c[0]).sort()
    expect(names).toEqual(['a', 'b'])
  })

  it('does not watch a .git dir that does not exist', async () => {
    const dir = writeFeature('alpha') // no git init
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir, store })
    await watcher.startInitialScan()
    recompute.mockClear()

    // Nothing to watch; creating a plain file must not trigger any recompute.
    fs.mkdirSync(path.join(dir, 'unrelated'), { recursive: true })
    await new Promise((r) => setTimeout(r, 150))
    expect(recompute).not.toHaveBeenCalled()
  })

  it('skips watchGitDir when the resolved git root has no .git dir', async () => {
    const dir = writeFeature('alpha') // no git init
    const { store, recompute } = fakeStore()
    // Force getGitRoot to resolve to a root whose .git subdir doesn't exist —
    // exercises watchGitDir's own existence guard rather than getGitRoot's.
    const spy = vi.spyOn(gitRepo, 'getGitRoot').mockResolvedValue(dir)
    try {
      watcher = startWatcher({ featuresDir, store })
      await watcher.startInitialScan()
      await waitFor(() => spy.mock.calls.length >= 1)
      // No .git dir at `dir`, so watchGitDir must bail without registering a watcher.
      await new Promise((r) => setTimeout(r, 150))
      recompute.mockClear()
      fs.mkdirSync(path.join(dir, '.git-lookalike'), { recursive: true })
      await new Promise((r) => setTimeout(r, 150))
      expect(recompute).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('does not schedule recompute after close()', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir, store, debounceMs: 20 })
    await watcher.startInitialScan()
    recompute.mockClear()

    watcher.close()
    expect(watchControl.fire(path.join('alpha', 'e2e'))).toBe(false)
    await new Promise((r) => setTimeout(r, 150))
    expect(recompute).not.toHaveBeenCalled()
  })

  it('logs when fs.watch throws on the feature e2e dir', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const { store } = fakeStore()
    const log = vi.fn()
    const watchPath: WatchPath = () => {
      throw new Error('EMFILE: too many open files')
    }
    watcher = startDirtySpecWatcher({ featuresDir, store, log, watchPath })
    await watcher.startInitialScan()
    await waitFor(() => log.mock.calls.some((c) => c[0] === 'failed to watch feature e2e dir'))
    expect(log).toHaveBeenCalledWith('failed to watch feature e2e dir', expect.any(Error))
  })

  it('logs when a feature watcher emits an asynchronous error', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const { store } = fakeStore()
    const log = vi.fn()
    const emittedWatcher = new EventEmitter() as fs.FSWatcher
    emittedWatcher.close = vi.fn()
    const watchPath: WatchPath = () => emittedWatcher

    watcher = startDirtySpecWatcher({ featuresDir, store, log, watchPath })
    emittedWatcher.emit('error', new Error('EMFILE: too many open files'))

    expect(log).toHaveBeenCalledWith('failed to watch feature e2e dir', expect.any(Error))
  })

  it('logs when fs.watch throws on the .git dir', async () => {
    writeFeature('alpha', { withGit: true })
    const { store } = fakeStore()
    const log = vi.fn()
    const watchPath: WatchPath = () => {
      throw new Error('EMFILE: too many open files')
    }
    watcher = startDirtySpecWatcher({ featuresDir, store, log, watchPath })
    await watcher.startInitialScan()
    await waitFor(() => log.mock.calls.some((c) => c[0] === 'failed to watch .git dir'), 6000)
    expect(log).toHaveBeenCalledWith('failed to watch .git dir', expect.any(Error))
  })

  it('a watch callback firing after close() is a no-op (closed guard)', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir, store })
    await watcher.startInitialScan()
    recompute.mockClear()
    const listener = watchControl.listener(path.join('alpha', 'e2e'))

    watcher.close()
    // Simulate the underlying watcher delivering an event that was already in
    // flight when close() ran — scheduleRecompute's closed guard must swallow it.
    listener('change', 'a.spec.ts')
    await new Promise((r) => setTimeout(r, 300))
    expect(recompute).not.toHaveBeenCalled()
  })

  it('coalesces two events inside one debounce window into a single recompute', async () => {
    const dir = writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir, store, debounceMs: 60 })
    await watcher.startInitialScan()
    recompute.mockClear()

    // Both events land in the SAME tick, so the second is guaranteed to find
    // the first's pending timer and clear it. Writing the spec file twice does
    // not reliably get there: the OS may coalesce a save-storm into a single
    // fs.watch event, in which case scheduleRecompute runs once and the timer
    // reset never happens — which is exactly how this branch stayed
    // intermittently uncovered.
    expect(watchControl.fire(path.join('alpha', 'e2e'))).toBe(true)
    expect(watchControl.fire(path.join('alpha', 'e2e'))).toBe(true)

    await waitFor(() => recompute.mock.calls.length >= 1)
    // Wait out another full window: a second recompute would mean the first
    // timer survived instead of being cleared.
    await new Promise((r) => setTimeout(r, 200))
    expect(recompute).toHaveBeenCalledTimes(1)
    expect(recompute).toHaveBeenCalledWith('alpha', dir)
  })

  it('close() clears pending debounce timers and is safe to call twice', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startWatcher({ featuresDir, store, debounceMs: 500 })
    await watcher.startInitialScan()
    recompute.mockClear()

    // Fired through the seam rather than by writing the spec file. A real
    // fs.watch event that lands AFTER close() leaves no pending timer at all,
    // and "recompute never ran" is then trivially true — the test would pass
    // having proven nothing, and close()'s clear-timers loop would never run.
    // On a loaded machine that is exactly what happened, which is why this
    // one statement went uncovered intermittently.
    expect(watchControl.fire(path.join('alpha', 'e2e'))).toBe(true)

    expect(() => {
      watcher!.close()
      watcher!.close()
    }).not.toThrow()

    // Past the full debounce window: the timer was cancelled, not merely
    // outrun. Without the clear, this is where the recompute would land.
    await new Promise((r) => setTimeout(r, 600))
    expect(recompute).not.toHaveBeenCalled()
  })
})
