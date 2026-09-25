// Fix-capture arms the orchestrator tests don't reach: a worktree git can stash
// but not describe, a patch that can't be written to disk, and an overlay whose
// reverse fails for a reason other than a conflict. Git and the overlay
// helpers are mocked so each shape is exact rather than coaxed out of a real
// repository.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { RunContext } from './run-context'
import type { RunnerLog } from './runner-log'
import { readManifest, writeManifest } from './manifest'
import { FileRunStateSink } from './run-state-sink'
import { FIX_CAPTURE_MAX_FILE_NAMES } from '../../../../../../../shared/run-state'

const h = vi.hoisted(() => ({
  snapshotWorkingTree: vi.fn(),
  runGit: vi.fn(),
  diffContentSinceSnapshot: vi.fn(),
  diffNamesSinceSnapshot: vi.fn(),
  listUntracked: vi.fn(),
  reverseOverlay: vi.fn(),
}))

vi.mock('../../../../shared/git-repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/git-repo')>()),
  snapshotWorkingTree: h.snapshotWorkingTree,
  runGit: h.runGit,
  diffContentSinceSnapshot: h.diffContentSinceSnapshot,
  diffNamesSinceSnapshot: h.diffNamesSinceSnapshot,
}))
vi.mock('./repo-worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repo-worktree')>()),
  listUntracked: h.listUntracked,
}))
vi.mock('../../../portify/logic/runtime/git-ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../portify/logic/runtime/git-ops')>()),
  reverseOverlay: h.reverseOverlay,
}))

const { captureFixBaseline, captureFixes, reversePortifyOverlay, startLiveFixCapture } = await import('./run-fix-capture')
const { makeHealLoopContext } = await import('./__fixtures__/heal-loop-context')

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fixcap-')))
  vi.clearAllMocks()
  h.listUntracked.mockResolvedValue(new Set<string>())
  h.runGit.mockResolvedValue({ code: 0, stdout: 'abc123\n', stderr: '' })
  h.diffContentSinceSnapshot.mockResolvedValue('diff --git a/x b/x\n')
  h.diffNamesSinceSnapshot.mockResolvedValue(['src/app.ts'])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function fakeRunnerLog(): RunnerLog & { infos: string[]; warnings: string[] } {
  const infos: string[] = []
  const warnings: string[] = []
  return {
    infos,
    warnings,
    info: (m: string) => { infos.push(m) },
    warn: (m: string) => { warnings.push(m) },
    error: () => {},
  } as unknown as RunnerLog & { infos: string[]; warnings: string[] }
}

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const made = makeHealLoopContext({ root: tmpDir, opts, state })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  return made
}

function worktree(repoName = 'app') {
  const root = path.join(tmpDir, 'wt', repoName)
  fs.mkdirSync(root, { recursive: true })
  return { repoName, worktreeRoot: root, sourceRoot: path.join(tmpDir, 'src', repoName), localPath: root }
}

describe('captureFixBaseline', () => {
  it('records an empty base SHA when git cannot resolve HEAD', async () => {
    const { ctx } = ctxFor({ worktreeHandles: [worktree()] as never })
    h.snapshotWorkingTree.mockResolvedValue('stash-ref')
    // A worktree git can stash but not describe — e.g. a repo with no commit yet.
    h.runGit.mockResolvedValue({ code: 128, stdout: '', stderr: 'ambiguous argument HEAD' })

    await captureFixBaseline(ctx)

    expect(ctx.fixBaselines.get('app')).toMatchObject({ ref: 'stash-ref', baseSha: '' })
  })

  it('records the resolved SHA when git can describe the worktree', async () => {
    const { ctx } = ctxFor({ worktreeHandles: [worktree()] as never })
    h.snapshotWorkingTree.mockResolvedValue('stash-ref')

    await captureFixBaseline(ctx)

    expect(ctx.fixBaselines.get('app')).toMatchObject({ baseSha: 'abc123' })
  })

  it('skips a repo it cannot snapshot rather than filing a blank baseline', async () => {
    const { ctx } = ctxFor({ worktreeHandles: [worktree()] as never })
    h.snapshotWorkingTree.mockResolvedValue(null)

    await captureFixBaseline(ctx)

    expect(ctx.fixBaselines.size).toBe(0)
  })
})

describe('captureFixes', () => {
  function withBaseline(runnerLog?: RunnerLog) {
    const made = ctxFor({ healCycles: 1 }, runnerLog ? { runnerLog } : {})
    const wt = worktree()
    made.ctx.fixBaselines.set('app', {
      ref: 'stash-ref',
      worktreeRoot: wt.worktreeRoot,
      sourceRoot: wt.sourceRoot,
      baseSha: 'abc123',
      untracked: new Set<string>(),
    })
    return made
  }

  it('returns null before any heal cycle has run', async () => {
    const { ctx } = withBaseline()
    ctx.healCycles = 0
    expect(await captureFixes(ctx)).toBeNull()
  })

  it('returns null when no worktree has a baseline', async () => {
    const { ctx } = ctxFor({ healCycles: 1 })
    expect(await captureFixes(ctx)).toBeNull()
  })

  it('names the captured repos in the runner log', async () => {
    const runnerLog = fakeRunnerLog()
    const { ctx } = withBaseline(runnerLog)

    const capture = await captureFixes(ctx)

    expect(capture?.repos).toEqual([expect.objectContaining({ repoName: 'app', files: 1, fileNames: ['src/app.ts'] })])
    expect((runnerLog as unknown as { infos: string[] }).infos).toEqual([
      expect.stringContaining('Captured heal fix diff for app'),
    ])
  })

  it('caps the recorded file names while keeping the true count', async () => {
    // The manifest is re-read on every run-detail fetch, so a pathological
    // repair must not turn it into a path dump — but the count still has to
    // tell the truth, or the UI would claim the short list is complete.
    const many = Array.from({ length: FIX_CAPTURE_MAX_FILE_NAMES + 30 }, (_, i) => `src/f${i}.ts`)
    h.diffNamesSinceSnapshot.mockResolvedValue(many)
    const { ctx } = withBaseline()

    const capture = await captureFixes(ctx)

    expect(capture?.repos[0].files).toBe(many.length)
    expect(capture?.repos[0].fileNames).toHaveLength(FIX_CAPTURE_MAX_FILE_NAMES)
  })

  it('warns and skips the repo when the patch cannot be written', async () => {
    const runnerLog = fakeRunnerLog()
    const { ctx } = withBaseline(runnerLog)
    const realWrite = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: string, data: string) => {
      if (String(p).endsWith('app.patch.tmp')) throw new Error('EROFS: read-only file system')
      return realWrite(p, data)
    }) as typeof fs.writeFileSync)

    const capture = await captureFixes(ctx)

    expect(capture).toBeNull()
    expect((runnerLog as unknown as { warnings: string[] }).warnings).toEqual([
      expect.stringContaining('Fix capture write failed for "app": EROFS: read-only file system'),
    ])
  })

  it('captures nothing when the agent left the worktree unchanged', async () => {
    const { ctx } = withBaseline()
    h.diffContentSinceSnapshot.mockResolvedValue('   \n')

    expect(await captureFixes(ctx)).toBeNull()
  })

  it('publishes an evolving patch and then finalizes it without waiting to discover edits', async () => {
    const { ctx } = withBaseline()
    Object.assign(ctx, { stateSink: new FileRunStateSink(path.join(tmpDir, 'logs')) })
    writeManifest(ctx.paths.manifestPath, {
      runId: ctx.runId, feature: 'demo', featureDir: ctx.feature.featureDir,
      startedAt: 'now', status: 'healing', healCycles: 1, services: [],
    })

    const live = await captureFixes(ctx, true)
    expect(live?.provisional).toBe(true)
    expect(readManifest(ctx.paths.manifestPath)?.fixCapture?.repos[0].fileNames).toEqual(['src/app.ts'])
    expect((await captureFixes(ctx, true))?.capturedAt).toBe(live?.capturedAt)

    const final = await captureFixes(ctx)
    expect(final?.provisional).toBeUndefined()
    expect(readManifest(ctx.paths.manifestPath)?.fixCapture?.provisional).toBeUndefined()

    await captureFixes(ctx, true)
    h.diffContentSinceSnapshot.mockResolvedValue('')
    expect(await captureFixes(ctx, true)).toBeNull()
    expect(readManifest(ctx.paths.manifestPath)?.fixCapture).toBeUndefined()
    expect(fs.existsSync(path.join(ctx.paths.fixesDir, 'app.patch'))).toBe(false)
    expect(fs.existsSync(path.join(ctx.paths.fixesDir, 'fixes.json'))).toBe(false)
  })

  it('removes a stale patch when one repo has no current fix and reports cleanup failure', async () => {
    const log = fakeRunnerLog()
    const { ctx } = withBaseline(log)
    const other = worktree('other')
    ctx.fixBaselines.set('other', { ref: 'stash-ref', worktreeRoot: other.worktreeRoot, sourceRoot: other.sourceRoot, baseSha: 'abc123', untracked: new Set() })
    Object.assign(ctx, { stateSink: new FileRunStateSink(path.join(tmpDir, 'logs')) })
    writeManifest(ctx.paths.manifestPath, { runId: ctx.runId, feature: 'demo', startedAt: 'now', status: 'healing', healCycles: 1, services: [] })
    expect((await captureFixes(ctx, true))?.repos.map((repo) => repo.repoName)).toEqual(['app', 'other'])

    h.diffContentSinceSnapshot.mockImplementation(async (root: string) => root === other.worktreeRoot ? '' : 'diff --git a/x b/x\n')
    const remove = vi.spyOn(fs, 'rmSync').mockImplementation((target, _opts) => {
      if (String(target).endsWith('other.patch')) throw new Error('cleanup denied')
    })
    expect((await captureFixes(ctx, true))?.repos.map((repo) => repo.repoName)).toEqual(['app'])
    expect(log.warnings).toContain('Stale fix patch cleanup failed: cleanup denied')
    remove.mockRestore()
  })

  it('publishes a worktree edit from the file watcher before reconciliation', async () => {
    const { ctx, sink } = withBaseline()
    let changed: fs.WatchListener<string> | undefined
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher
    const monitor = startLiveFixCapture(ctx, {
      watchPath: (_root, listener) => { changed = listener; return watcher },
      debounceMs: 1,
      reconcileMs: 60_000,
    })

    changed?.('change', 'src/app.ts')
    await vi.waitFor(() => expect(sink.patches).toEqual([
      expect.objectContaining({ fixCapture: expect.objectContaining({ provisional: true }) }),
    ]))
    await monitor.close()
    expect(watcher.close).toHaveBeenCalledOnce()
  })

  it('reports watcher setup, runtime, and close failures without losing the run', async () => {
    const log = fakeRunnerLog()
    const { ctx } = withBaseline(log)
    const broken = startLiveFixCapture(ctx, { watchPath: () => { throw new Error('watch unavailable') } })
    expect(log.warnings).toContain('Live fix watcher failed: watch unavailable')
    await broken.close()

    const watcher = Object.assign(new EventEmitter(), { close: () => { throw new Error('close unavailable') } }) as unknown as fs.FSWatcher
    const monitor = startLiveFixCapture(ctx, { watchPath: () => watcher })
    watcher.emit('error', new Error('watch stopped'))
    await monitor.close()
    expect(log.warnings).toContain('Live fix watcher failed: watch stopped')
    expect(log.warnings).toContain('Live fix watcher close failed: close unavailable')
  })

  it('ignores dependency tree events and reports a failed capture', async () => {
    const log = fakeRunnerLog()
    const { ctx } = withBaseline(log)
    let changed: fs.WatchListener<string> | undefined
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher
    const monitor = startLiveFixCapture(ctx, {
      watchPath: (_root, listener) => { changed = listener; return watcher },
      debounceMs: 1,
      reconcileMs: 60_000,
    })
    h.diffContentSinceSnapshot.mockRejectedValueOnce(new Error('diff unavailable'))

    changed?.('change', '.git/index')
    expect(h.diffContentSinceSnapshot).not.toHaveBeenCalled()
    changed?.('change', 'src/app.ts')
    await vi.waitFor(() => expect(log.warnings).toContain('Live fix capture failed: diff unavailable'))
    await monitor.close()
  })

  it('does not capture a watcher event before any heal cycle', async () => {
    vi.useFakeTimers()
    const { ctx } = withBaseline()
    ctx.healCycles = 0
    let changed: fs.WatchListener<string> | undefined
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher
    const monitor = startLiveFixCapture(ctx, { watchPath: (_root, listener) => { changed = listener; return watcher }, debounceMs: 1 })

    changed?.('change', 'src/app.ts')
    await vi.advanceTimersByTimeAsync(1)

    expect(h.diffContentSinceSnapshot).not.toHaveBeenCalled()
    await monitor.close()
  })

  it('rescans after a second change arrives during an in-flight capture', async () => {
    vi.useFakeTimers()
    const { ctx } = withBaseline()
    let changed: fs.WatchListener<string> | undefined
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher
    let releaseFirst: (patch: string) => void = () => {}
    h.diffContentSinceSnapshot.mockImplementationOnce(() => new Promise<string>((resolve) => { releaseFirst = resolve }))
    const monitor = startLiveFixCapture(ctx, {
      watchPath: (_root, listener) => { changed = listener; return watcher },
      debounceMs: 1,
      reconcileMs: 60_000,
    })

    changed?.('change', 'src/first.ts')
    changed?.('change', 'src/duplicate.ts')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.diffContentSinceSnapshot).toHaveBeenCalledTimes(1)
    changed?.('change', 'src/second.ts')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.diffContentSinceSnapshot).toHaveBeenCalledTimes(1)
    releaseFirst('diff --git a/x b/x\n')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.diffContentSinceSnapshot).toHaveBeenCalledTimes(2)
    await monitor.close()
    changed?.('change', 'src/after-close.ts')
    expect(h.diffContentSinceSnapshot).toHaveBeenCalledTimes(2)
  })
})

describe('reversePortifyOverlay', () => {
  it('logs the revert when the overlay comes off cleanly', async () => {
    const runnerLog = fakeRunnerLog()
    const made = ctxFor({}, { runnerLog })
    made.ctx.appliedOverlays.push({ repoName: 'app', worktreeRoot: tmpDir, patchPath: 'p' })
    h.reverseOverlay.mockResolvedValue({ kind: 'ok' })

    await reversePortifyOverlay(made.ctx)

    expect((runnerLog as unknown as { infos: string[] }).infos).toEqual([
      expect.stringContaining('Reverted port overlay for "app"'),
    ])
    expect(made.ctx.appliedOverlays).toEqual([])
  })

  it('names the conflicting files when heal edits overlap the patch', async () => {
    const runnerLog = fakeRunnerLog()
    const made = ctxFor({}, { runnerLog })
    made.ctx.appliedOverlays.push({ repoName: 'app', worktreeRoot: tmpDir, patchPath: 'p' })
    h.reverseOverlay.mockResolvedValue({ kind: 'conflict', files: ['src/server.ts', 'src/app.ts'], detail: 'x' })

    await reversePortifyOverlay(made.ctx)

    expect((runnerLog as unknown as { warnings: string[] }).warnings).toEqual([
      expect.stringContaining('(src/server.ts, src/app.ts)'),
    ])
  })

  // Not a conflict — git refused for some other reason, and the outcome carries
  // a detail string instead of a file list.
  it('falls back to the error detail for a non-conflict failure', async () => {
    const runnerLog = fakeRunnerLog()
    const made = ctxFor({}, { runnerLog })
    made.ctx.appliedOverlays.push({ repoName: 'app', worktreeRoot: tmpDir, patchPath: 'p' })
    h.reverseOverlay.mockResolvedValue({ kind: 'error', detail: 'corrupt patch at line 3' })

    await reversePortifyOverlay(made.ctx)

    expect((runnerLog as unknown as { warnings: string[] }).warnings).toEqual([
      expect.stringContaining('(corrupt patch at line 3)'),
    ])
  })

  it('is a no-op when this run applied no overlay', async () => {
    const { ctx } = ctxFor()
    await reversePortifyOverlay(ctx)
    expect(h.reverseOverlay).not.toHaveBeenCalled()
  })
})
