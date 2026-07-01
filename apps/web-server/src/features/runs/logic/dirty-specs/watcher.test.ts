import { execFileSync } from 'child_process'
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

let watcher: DirtySpecWatcher | undefined

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-watcher-')))
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
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
    watcher = startDirtySpecWatcher({ featuresDir, store })
    await waitFor(() => recompute.mock.calls.length >= 1)
    expect(recompute).toHaveBeenCalledWith('alpha', dir)
  })

  it('logs when the initial recompute rejects', async () => {
    const recompute = vi.fn().mockRejectedValue(new Error('boom'))
    const store = { recompute } as unknown as DirtySpecStore
    const log = vi.fn()
    writeFeature('alpha')
    watcher = startDirtySpecWatcher({ featuresDir, store, log })
    await waitFor(() => log.mock.calls.length >= 1)
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
    watcher = startDirtySpecWatcher({ featuresDir, store })
    // Give any async work a chance to run; recompute must never fire for `bad`.
    await new Promise((r) => setTimeout(r, 100))
    expect(recompute).not.toHaveBeenCalledWith('bad', expect.anything())
  })

  it('debounces a spec save in the e2e dir and recomputes after the window', async () => {
    const dir = writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startDirtySpecWatcher({ featuresDir, store, debounceMs: 200 })
    await waitFor(() => recompute.mock.calls.length >= 1) // initial recompute
    recompute.mockClear()

    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'test()')
    // A rapid second save inside the debounce window resets the timer, so the
    // recompute only fires once the window elapses from the LAST write.
    await new Promise((r) => setTimeout(r, 20))
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'test() // edited')

    // Not yet — still inside the (reset) debounce window.
    await new Promise((r) => setTimeout(r, 50))
    expect(recompute).not.toHaveBeenCalled()

    await waitFor(() => recompute.mock.calls.length >= 1)
    expect(recompute).toHaveBeenCalledWith('alpha', dir)
  })

  it('ignores non-.spec.ts filenames in the e2e dir', async () => {
    const dir = writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startDirtySpecWatcher({ featuresDir, store, debounceMs: 20 })
    await waitFor(() => recompute.mock.calls.length >= 1)
    recompute.mockClear()

    fs.writeFileSync(path.join(dir, 'e2e', 'notes.txt'), 'irrelevant')
    await new Promise((r) => setTimeout(r, 150))
    expect(recompute).not.toHaveBeenCalled()
  })

  it('calls onSpecFileChanged once when a real spec-content change triggers the debounce', async () => {
    const dir = writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    const onSpecFileChanged = vi.fn()
    watcher = startDirtySpecWatcher({ featuresDir, store, debounceMs: 20, onSpecFileChanged })
    await waitFor(() => recompute.mock.calls.length >= 1)
    recompute.mockClear()

    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'test()')
    await waitFor(() => onSpecFileChanged.mock.calls.length >= 1)
    expect(onSpecFileChanged).toHaveBeenCalledWith('alpha')
    expect(onSpecFileChanged).toHaveBeenCalledTimes(1)
  })

  it('logs when a debounced recompute rejects', async () => {
    const dir = writeFeature('alpha', { withE2eDir: true })
    const recompute = vi
      .fn()
      .mockResolvedValueOnce(undefined) // initial recompute succeeds
      .mockRejectedValue(new Error('recompute broke'))
    const store = { recompute } as unknown as DirtySpecStore
    const log = vi.fn()
    watcher = startDirtySpecWatcher({ featuresDir, store, debounceMs: 20, log })
    await waitFor(() => recompute.mock.calls.length >= 1)
    log.mockClear()

    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'test()')
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
    watcher = startDirtySpecWatcher({ featuresDir: repoRoot, store, debounceMs: 20 })
    await waitFor(() => recompute.mock.calls.length >= 2, 6000) // initial recompute for a + b
    // getGitRoot resolves asynchronously (a real `git` subprocess call); give the
    // .git watch registration time to land before clearing and asserting on it.
    await new Promise((r) => setTimeout(r, 300))
    recompute.mockClear()

    // Simulate a commit touching .git's direct children.
    fs.writeFileSync(path.join(repoRoot, '.git', 'COMMIT_EDITMSG'), 'update')

    await waitFor(() => recompute.mock.calls.length >= 2, 6000)
    const names = recompute.mock.calls.map((c) => c[0]).sort()
    expect(names).toEqual(['a', 'b'])
  })

  it('does not watch a .git dir that does not exist', async () => {
    const dir = writeFeature('alpha') // no git init
    const { store, recompute } = fakeStore()
    watcher = startDirtySpecWatcher({ featuresDir, store })
    await waitFor(() => recompute.mock.calls.length >= 1)
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
      watcher = startDirtySpecWatcher({ featuresDir, store })
      await waitFor(() => recompute.mock.calls.length >= 1)
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
    const dir = writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startDirtySpecWatcher({ featuresDir, store, debounceMs: 20 })
    await waitFor(() => recompute.mock.calls.length >= 1)
    recompute.mockClear()

    watcher.close()
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'test()')
    await new Promise((r) => setTimeout(r, 150))
    expect(recompute).not.toHaveBeenCalled()
  })

  it('logs when fs.watch throws on the feature e2e dir', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const { store } = fakeStore()
    const log = vi.fn()
    const spy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('EMFILE: too many open files')
    })
    try {
      watcher = startDirtySpecWatcher({ featuresDir, store, log })
      await waitFor(() => log.mock.calls.some((c) => c[0] === 'failed to watch feature e2e dir'))
      expect(log).toHaveBeenCalledWith('failed to watch feature e2e dir', expect.any(Error))
    } finally {
      spy.mockRestore()
    }
  })

  it('logs when fs.watch throws on the .git dir', async () => {
    writeFeature('alpha', { withGit: true })
    const { store } = fakeStore()
    const log = vi.fn()
    const spy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('EMFILE: too many open files')
    })
    try {
      watcher = startDirtySpecWatcher({ featuresDir, store, log })
      await waitFor(() => log.mock.calls.some((c) => c[0] === 'failed to watch .git dir'), 6000)
      expect(log).toHaveBeenCalledWith('failed to watch .git dir', expect.any(Error))
    } finally {
      spy.mockRestore()
    }
  })

  it('a watch callback firing after close() is a no-op (closed guard)', async () => {
    writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    let e2eListener: ((event: string, filename: string | null) => void) | undefined
    const realWatch = fs.watch.bind(fs)
    const spy = vi.spyOn(fs, 'watch').mockImplementation(((...args: Parameters<typeof fs.watch>) => {
      const [target, , listener] = args
      if (typeof target === 'string' && target.endsWith(path.join('alpha', 'e2e')) && typeof listener === 'function') {
        e2eListener = listener as (event: string, filename: string | null) => void
      }
      return (realWatch as (...a: unknown[]) => fs.FSWatcher)(...args)
    }) as typeof fs.watch)
    try {
      watcher = startDirtySpecWatcher({ featuresDir, store })
      await waitFor(() => recompute.mock.calls.length >= 1)
      recompute.mockClear()
      expect(e2eListener).toBeTypeOf('function')

      watcher.close()
      // Simulate the underlying fs watcher delivering an event that was already
      // in flight when close() ran — scheduleRecompute's `closed` guard must
      // swallow it rather than scheduling a timer after teardown.
      e2eListener!('change', 'a.spec.ts')
      await new Promise((r) => setTimeout(r, 300))
      expect(recompute).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('close() clears pending debounce timers and is safe to call twice', async () => {
    const dir = writeFeature('alpha', { withE2eDir: true })
    const { store, recompute } = fakeStore()
    watcher = startDirtySpecWatcher({ featuresDir, store, debounceMs: 500 })
    await waitFor(() => recompute.mock.calls.length >= 1)
    recompute.mockClear()

    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'test()')
    await new Promise((r) => setTimeout(r, 50)) // inside the debounce window
    expect(() => {
      watcher!.close()
      watcher!.close()
    }).not.toThrow()

    await new Promise((r) => setTimeout(r, 600))
    expect(recompute).not.toHaveBeenCalled()
  })
})
