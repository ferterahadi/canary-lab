// Playwright-side arms the orchestrator tests don't reach: artifact retention
// against a hostile destination, the exit waiter with nothing running, and a
// verification run aborted before it starts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { persistPlaywrightArtifacts, runPlaywright, runVerification, waitForPlaywrightExit } from './run-playwright'
import { snapshotSuite } from './run-suite-snapshot'
import type { PlaywrightSpawner } from './run-spawn'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { RunContext } from './run-context'
import type { RunnerLog } from './runner-log'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pw-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const made = makeHealLoopContext({ root: tmpDir, opts, state })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  return made
}

/** Collects the warnings artifact retention emits instead of failing the run. */
function fakeRunnerLog(): RunnerLog & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    warn: (m: string) => { warnings.push(m) },
    info: () => {},
    error: () => {},
  } as unknown as RunnerLog & { warnings: string[] }
}

describe('persistPlaywrightArtifacts', () => {
  it('does nothing when Playwright produced no artifact dir at all', () => {
    const { ctx } = ctxFor()
    expect(() => persistPlaywrightArtifacts(ctx)).not.toThrow()
    expect(fs.existsSync(ctx.paths.playwrightArtifactsKeepDir)).toBe(false)
  })

  it('gives up quietly when the keep dir cannot be created', () => {
    const { ctx } = ctxFor()
    fs.mkdirSync(ctx.paths.playwrightArtifactsDir, { recursive: true })
    // A plain file where the keep directory belongs — mkdir throws ENOTDIR/EEXIST.
    fs.writeFileSync(ctx.paths.playwrightArtifactsKeepDir, 'not a directory')

    expect(() => persistPlaywrightArtifacts(ctx)).not.toThrow()
    expect(fs.statSync(ctx.paths.playwrightArtifactsKeepDir).isFile()).toBe(true)
  })

  it('gives up quietly when the artifact dir cannot be listed', () => {
    const { ctx } = ctxFor()
    fs.mkdirSync(ctx.paths.playwrightArtifactsDir, { recursive: true })
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('EACCES') })

    expect(() => persistPlaywrightArtifacts(ctx)).not.toThrow()
  })

  it('copies per-test directories and skips loose files beside them', () => {
    const { ctx } = ctxFor()
    const src = ctx.paths.playwrightArtifactsDir
    fs.mkdirSync(path.join(src, 'checkout-total'), { recursive: true })
    fs.writeFileSync(path.join(src, 'checkout-total', 'trace.zip'), 'trace')
    // Playwright drops report files alongside the per-test dirs; only the
    // directories are retained.
    fs.writeFileSync(path.join(src, 'report.json'), '{}')

    persistPlaywrightArtifacts(ctx)

    const keep = ctx.paths.playwrightArtifactsKeepDir
    expect(fs.readFileSync(path.join(keep, 'checkout-total', 'trace.zip'), 'utf-8')).toBe('trace')
    expect(fs.existsSync(path.join(keep, 'report.json'))).toBe(false)
  })

  it('warns and keeps going when one artifact fails to copy', () => {
    const runnerLog = fakeRunnerLog()
    const { ctx } = ctxFor({}, { runnerLog })
    const src = ctx.paths.playwrightArtifactsDir
    fs.mkdirSync(path.join(src, 'one'), { recursive: true })
    fs.mkdirSync(path.join(src, 'two'), { recursive: true })
    fs.writeFileSync(path.join(src, 'two', 'video.webm'), 'video')
    let calls = 0
    const realRm = fs.rmSync
    vi.spyOn(fs, 'rmSync').mockImplementation(((p: string, o: object) => {
      calls += 1
      if (calls === 1) throw new Error('EBUSY')
      return realRm(p, o)
    }) as typeof fs.rmSync)

    persistPlaywrightArtifacts(ctx)

    expect(runnerLog.warnings).toEqual([expect.stringContaining('persist playwright artifact one failed: EBUSY')])
    // The second artifact still landed — one bad copy must not skip the rest.
    expect(fs.existsSync(path.join(ctx.paths.playwrightArtifactsKeepDir, 'two', 'video.webm'))).toBe(true)
  })

  it('stringifies a non-Error throw rather than logging "undefined"', () => {
    const runnerLog = fakeRunnerLog()
    const { ctx } = ctxFor({}, { runnerLog })
    fs.mkdirSync(path.join(ctx.paths.playwrightArtifactsDir, 'one'), { recursive: true })
    vi.spyOn(fs, 'rmSync').mockImplementation((() => { throw 'disk gave up' }) as typeof fs.rmSync)

    persistPlaywrightArtifacts(ctx)

    expect(runnerLog.warnings).toEqual([expect.stringContaining('persist playwright artifact one failed: disk gave up')])
  })
})

describe('waitForPlaywrightExit', () => {
  it('resolves null immediately when no Playwright process is running', async () => {
    const { ctx } = ctxFor()
    await expect(waitForPlaywrightExit(ctx, 5_000)).resolves.toBeNull()
  })

  it('resolves with the exit info the waiter is handed', async () => {
    const { ctx } = ctxFor({ playwrightPty: {} as RunContext['playwrightPty'] })
    const pending = waitForPlaywrightExit(ctx, 5_000)
    ctx.playwrightExitWaiter?.({ exitCode: 0 })
    await expect(pending).resolves.toEqual({ exitCode: 0 })
  })

  it('resolves null and drops the waiter when the wait times out', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = ctxFor({ playwrightPty: {} as RunContext['playwrightPty'] })
      const pending = waitForPlaywrightExit(ctx, 1_000)
      vi.advanceTimersByTime(1_000)
      await expect(pending).resolves.toBeNull()
      expect(ctx.playwrightExitWaiter).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

const exit0Pty = () => ({
  pid: 42,
  onData: () => ({ dispose() {} }),
  onExit: (cb: (e: { exitCode: number }) => void) => { setTimeout(() => cb({ exitCode: 0 }), 0); return { dispose() {} } },
  write() {}, resize() {}, kill() {},
})

function spec(dir: string, name: string, body: string): void {
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'e2e', name), body)
}

describe('runPlaywright — the snapshot boundary', () => {
  it('spawns every rerun from the run-start copy, so a signal_run rerun cannot pick up a live edit', async () => {
    const spawner = vi.fn<PlaywrightSpawner>(() => ({ command: 'noop', cwd: tmpDir }))
    const { ctx } = ctxFor({}, { ptyFactory: exit0Pty, playwrightSpawner: spawner })
    spec(ctx.feature.featureDir, 'a.spec.ts', "test('a', async () => {})\n")
    snapshotSuite(ctx)

    await runPlaywright(ctx, { kind: 'grep', grep: 'a', selected: 1, total: 1, mode: 'failed-and-pending', reason: 'r' })

    expect(spawner).toHaveBeenCalledWith(expect.objectContaining({ suiteDir: ctx.paths.suiteSnapshotDir }))
  })

  it('records the pending live edits on the manifest when Playwright exits', async () => {
    const { ctx, sink } = ctxFor({}, { ptyFactory: exit0Pty, playwrightSpawner: () => ({ command: 'noop', cwd: tmpDir }) })
    spec(ctx.feature.featureDir, 'a.spec.ts', "test('a', async () => { expect(1).toBe(1) })\n")
    snapshotSuite(ctx)
    spec(ctx.feature.featureDir, 'a.spec.ts', "test('a', async () => {})\n")

    await runPlaywright(ctx)

    expect(sink.patches).toContainEqual(expect.objectContaining({
      specEdits: expect.objectContaining({ pending: [expect.objectContaining({ file: 'e2e/a.spec.ts', change: 'modified' })] }),
    }))
  })
})

describe('a weaker pending edit never touches the status', () => {
  it('leaves the verdict where the executed copy put it and only adds a hint (D13)', async () => {
    const { ctx, sink } = ctxFor({}, { ptyFactory: exit0Pty, playwrightSpawner: () => ({ command: 'noop', cwd: tmpDir }) })
    spec(ctx.feature.featureDir, 'a.spec.ts', "test('a', async () => { expect(1).toBe(1); expect(2).toBe(2) })\n")
    snapshotSuite(ctx)
    // The agent gutted the live assertion after the snapshot. The copy — the
    // thing that ran — still holds both assertions, and it passed.
    spec(ctx.feature.featureDir, 'a.spec.ts', "test('a', async () => {})\n")
    fs.writeFileSync(ctx.paths.summaryPath, JSON.stringify({ passed: 1, failed: [], passedNames: ['test-case-a'] }))

    expect(await runVerification(ctx)).toBe('passed')
    const integrity = (sink.patches.find((p) => 'integrity' in p) as { integrity: { hints: Array<{ kind: string }> } }).integrity
    expect(integrity.hints.map((h) => h.kind)).toEqual(['weaker'])
  })
})

describe('runVerification', () => {
  it('returns the live status without running tests when the run was aborted', async () => {
    const { ctx } = ctxFor({ stopped: true, status: 'aborted' })

    expect(await runVerification(ctx)).toBe('aborted')
  })

  it('decides the verdict against the suite copy the tests ran from, not the live feature dir', async () => {
    // A spec added to features/<suite>/ mid-run is not in the snapshot; with
    // no reporter inventory the verdict falls back to listing spec files, so
    // reading the live dir would report the run as pending-and-failed for a
    // test Playwright was never handed. Every suite reader switches together.
    const { ctx } = ctxFor({}, { ptyFactory: exit0Pty, playwrightSpawner: () => ({ command: 'noop', cwd: tmpDir }) })
    spec(ctx.feature.featureDir, 'a.spec.ts', "test('a', async () => {})\n")
    spec(ctx.feature.featureDir, 'b.spec.ts', "test('b', async () => {})\n")
    ctx.suiteDir = path.join(ctx.runDir, 'suite')
    spec(ctx.suiteDir, 'a.spec.ts', "test('a', async () => {})\n")
    fs.writeFileSync(ctx.paths.summaryPath, JSON.stringify({ passed: 1, failed: [], passedNames: ['test-case-a'] }))

    expect(await runVerification(ctx)).toBe('passed')
  })
})
