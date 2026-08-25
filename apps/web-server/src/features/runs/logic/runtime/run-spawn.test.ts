import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { defaultPlaywrightSpawner, killTree, scheduleSigkillFallback, writeRerunTestList } from './run-spawn'
import type { PtyHandle } from './pty-spawner'
import type { RunPaths } from './run-paths'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'

// killTree is the only thing standing between an aborted run and a heal agent
// that outlives it, so both the process-group path and the per-pty fallback are
// pinned here rather than left to a live abort.

const fakePty = (overrides: Partial<PtyHandle> = {}): PtyHandle =>
  ({ pid: 4242, kill: vi.fn(), write: vi.fn(), resize: vi.fn(), ...overrides }) as unknown as PtyHandle

describe('rerun test-list file', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  })

  function mkPaths(): RunPaths {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rs-')))
    tmpDirs.push(runDir)
    return {
      runDir,
      rerunListPath: path.join(runDir, 'rerun-test-list.txt'),
      playwrightArtifactsDir: path.join(runDir, 'playwright-artifacts'),
    } as unknown as RunPaths
  }

  const feature = { featureDir: '/proj/features/demo' } as unknown as FeatureConfig

  it('writes one line per entry and adds --test-list to the command', () => {
    const paths = mkPaths()
    const inv = defaultPlaywrightSpawner({
      feature,
      paths,
      rerunSelection: {
        kind: 'test-list',
        testList: ['a.spec.ts › suite › a title', '[chromium] › b.spec.ts › b title'],
        selected: 2,
        total: 5,
        mode: 'failed-and-pending',
        reason: 'r',
      },
    })

    expect(fs.readFileSync(paths.rerunListPath, 'utf-8'))
      .toBe('a.spec.ts › suite › a title\n[chromium] › b.spec.ts › b title\n')
    expect(inv.command).toContain(`--test-list=${JSON.stringify(paths.rerunListPath)}`)
    // A test list replaces grep entirely — sending both would re-narrow by title.
    expect(inv.command).not.toContain('--grep')
  })

  it('omits the flag and writes no file for a grep selection', () => {
    const paths = mkPaths()
    const inv = defaultPlaywrightSpawner({
      feature,
      paths,
      rerunGrep: 'a title',
      rerunSelection: {
        kind: 'grep', grep: 'a title', selected: 1, total: 5, mode: 'failed-and-pending', reason: 'r',
      },
    })

    expect(fs.existsSync(paths.rerunListPath)).toBe(false)
    expect(inv.command).not.toContain('--test-list')
    expect(inv.command).toContain('--grep=')
  })

  it('writes nothing for an empty test list rather than an empty selector', () => {
    // An empty --test-list file would match zero tests, which Playwright reports
    // as an ordinary empty run — the verdict would then rest on nothing.
    const paths = mkPaths()
    expect(writeRerunTestList(paths.rerunListPath, {
      kind: 'test-list', testList: [], selected: 0, total: 5, mode: 'failed-and-pending', reason: 'r',
    })).toBe(false)
    expect(fs.existsSync(paths.rerunListPath)).toBe(false)
  })

  it('writes nothing when there is no selection at all (first full run)', () => {
    const paths = mkPaths()
    expect(writeRerunTestList(paths.rerunListPath, undefined)).toBe(false)
    const inv = defaultPlaywrightSpawner({ feature, paths })
    expect(inv.command).not.toContain('--test-list')
  })
})

afterEach(() => vi.restoreAllMocks())

describe('killTree', () => {
  it('signals the whole process group and stops there when that works', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const pty = fakePty()

    killTree(pty, 'SIGTERM')

    // Negative pid = the group, which is what reaches the shell's children.
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('falls back to the pty when the process group cannot be signalled', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    const pty = fakePty()

    killTree(pty, 'SIGKILL')

    expect(pty.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('passes no signal to the pty fallback when given a numeric signal', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    const pty = fakePty()

    killTree(pty, 9)

    // node-pty's kill takes a signal *name*; handing it a number would throw.
    expect(pty.kill).toHaveBeenCalledWith(undefined)
  })

  it('swallows a pty that is already dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    const pty = fakePty({ kill: vi.fn(() => { throw new Error('already exited') }) })

    expect(() => killTree(pty, 'SIGTERM')).not.toThrow()
  })

  // The two guard tests below are load-bearing safety, not book-keeping: a
  // fake pty with `pid: 1` once made `-pid` equal -1, and kill(-1, SIGTERM)
  // signalled every process the user owned — twice, with reboots (2026-08-04).
  it('never signals the group for a pid that cannot be a node-pty child (pid 1 → kill(-1) is a broadcast)', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const pty = fakePty({ pid: 1 })

    killTree(pty, 'SIGTERM')

    expect(kill).not.toHaveBeenCalled()
    expect(pty.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('treats a handle with no numeric pid as ungroupable and uses the per-pty kill', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const pty = fakePty({ pid: undefined as unknown as number })

    killTree(pty, 'SIGTERM')

    expect(kill).not.toHaveBeenCalled()
    expect(pty.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

describe('scheduleSigkillFallback', () => {
  afterEach(() => vi.useRealTimers())

  it('SIGKILLs the process group once the grace window elapses, and not before', () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const pty = fakePty()

    scheduleSigkillFallback(pty)

    expect(kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('swallows a group that is already gone at fire time', () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    scheduleSigkillFallback(fakePty())

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
  })

  // The deferred timer outlives any per-test process.kill mock, so this guard
  // is the only thing standing between a bogus fake pid and a real broadcast
  // SIGKILL two seconds after a suite's mocks were restored.
  it('never group-SIGKILLs a pid ≤ 1 — the per-pty kill is the whole escalation', () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const pty = fakePty({ pid: 1 })

    scheduleSigkillFallback(pty)
    vi.advanceTimersByTime(2000)

    expect(kill).not.toHaveBeenCalled()
    expect(pty.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('swallows an already-dead pty on the guarded escalation path too', () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const pty = fakePty({ pid: 1, kill: vi.fn(() => { throw new Error('already exited') }) })

    scheduleSigkillFallback(pty)

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
    expect(kill).not.toHaveBeenCalled()
  })
})

// Pins the suite-wide net in vitest.setup.ts, so removing that wiring (or the
// setupFiles entry) fails a test instead of re-arming the machine-wide kill.
describe('test-harness process.kill net', () => {
  it('blocks group/broadcast targets outright and lets real-pid signals through', () => {
    // No spy here on purpose: this asserts the REAL (wrapped) process.kill.
    // The marker check MUST come first and MUST fail the test outright: if the
    // net is gone, the calls below are no longer assertions but the incident
    // itself — a live kill(-1) broadcast. Never invoke a blocked target until
    // the wrapper is known to be installed.
    const marker = Symbol.for('canary-lab.test.killGuard')
    expect((process.kill as unknown as Record<symbol, boolean>)[marker]).toBe(true)
    expect(() => process.kill(-1, 'SIGTERM')).toThrow(/blocked process\.kill\(-1\)/)
    expect(() => process.kill(1, 'SIGTERM')).toThrow(/blocked process\.kill\(1\)/)
    // Signal 0 delivers nothing — proves positive pids still reach the OS.
    expect(process.kill(process.pid, 0)).toBe(true)
  })
})
