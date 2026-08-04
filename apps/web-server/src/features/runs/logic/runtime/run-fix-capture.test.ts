// Fix-capture arms the orchestrator tests don't reach: a worktree git can stash
// but not describe, a patch that can't be written to disk, and an overlay whose
// reverse fails for a reason other than a conflict. Git and the overlay
// helpers are mocked so each shape is exact rather than coaxed out of a real
// repository.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunContext } from './run-context'
import type { RunnerLog } from './runner-log'
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

const { captureFixBaseline, captureFixes, reversePortifyOverlay } = await import('./run-fix-capture')
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
      if (String(p).endsWith('app.patch')) throw new Error('EROFS: read-only file system')
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
