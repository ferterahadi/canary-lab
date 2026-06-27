import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: spawnMock }
})

import {
  UpdateJobStore,
  startUpdateJob,
  UpdateJobConflictError,
  type InstallRunner,
} from './update-job'

/** Minimal stand-in for a spawned child: stdout/stderr are their own emitters. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

let logsDir: string

beforeEach(() => {
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-update-job-'))
  spawnMock.mockReset()
})
afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

const collectEvents = () => {
  const events: { type: string }[] = []
  return { publish: (e: { type: string }) => events.push(e), events }
}

describe('startUpdateJob', () => {
  it('marks the job done on a zero exit code and emits version-changed', async () => {
    const store = new UpdateJobStore(logsDir)
    const bus = collectEvents()
    const run: InstallRunner = async ({ onOutput }) => {
      onOutput('added 1 package\n')
      return 0
    }
    const { manifest, completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store, run, workspaceEvents: bus },
    )
    expect(manifest.status).toBe('running')
    expect(manifest.targetVersion).toBe('1.4.2')
    await completion
    const final = store.current()
    expect(final?.status).toBe('done')
    expect(final?.log).toContain('added 1 package')
    expect(final?.endedAt).toBeTruthy()
    expect(bus.events).toEqual([{ type: 'version-changed' }])
  })

  it('marks the job failed on a non-zero exit code', async () => {
    const store = new UpdateJobStore(logsDir)
    const run: InstallRunner = async () => 1
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store, run },
    )
    await completion
    const final = store.current()
    expect(final?.status).toBe('failed')
    expect(final?.error).toContain('code 1')
  })

  it('refuses a second concurrent install (single-flight 409)', async () => {
    const store = new UpdateJobStore(logsDir)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = () => r() })
    const run: InstallRunner = async () => { await gate; return 0 }
    const first = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store, run },
    )
    expect(() =>
      startUpdateJob(
        { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
        { store, run },
      ),
    ).toThrow(UpdateJobConflictError)
    release()
    await first.completion
    // Once it settles, a fresh install is allowed again.
    expect(store.current()?.status).toBe('done')
  })
})

describe('startUpdateJob default installer (real spawn path)', () => {
  it('pipes stdout + stderr into the log and finishes done on close 0', async () => {
    const store = new UpdateJobStore(logsDir)
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store }, // no `run` -> defaultInstall
    )
    expect(spawnMock).toHaveBeenCalledWith('npm', ['install', 'canary-lab@latest'], {
      cwd: logsDir,
      env: process.env,
    })
    child.stdout.emit('data', Buffer.from('added 1 package\n'))
    child.stderr.emit('data', Buffer.from('npm warn deprecated\n'))
    child.emit('close', 0)
    await completion
    const final = store.current()
    expect(final?.status).toBe('done')
    expect(final?.log).toContain('added 1 package')
    expect(final?.log).toContain('npm warn deprecated')
  })

  it('fails with code 1 when the child closes with a null code', async () => {
    const store = new UpdateJobStore(logsDir)
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store },
    )
    child.emit('close', null)
    await completion
    expect(store.current()?.status).toBe('failed')
    expect(store.current()?.error).toContain('code 1')
  })

  it('logs a spawn error and fails when the child emits error', async () => {
    const store = new UpdateJobStore(logsDir)
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store },
    )
    child.emit('error', new Error('npm not found'))
    await completion
    const final = store.current()
    expect(final?.status).toBe('failed')
    expect(final?.log).toContain('[spawn error] npm not found')
  })

  it('stringifies a non-Error spawn error', async () => {
    const store = new UpdateJobStore(logsDir)
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store },
    )
    child.emit('error', 'kaboom')
    await completion
    expect(store.current()?.status).toBe('failed')
    expect(store.current()?.log).toContain('[spawn error] kaboom')
  })
})

describe('startUpdateJob runner rejection', () => {
  it('marks failed and appends the error when the runner throws', async () => {
    const store = new UpdateJobStore(logsDir)
    const run: InstallRunner = async () => { throw new Error('boom') }
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store, run },
    )
    await completion
    const final = store.current()
    expect(final?.status).toBe('failed')
    expect(final?.log).toContain('[error] boom')
    expect(final?.error).toContain('code 1')
  })

  it('stringifies a non-Error thrown by the runner', async () => {
    const store = new UpdateJobStore(logsDir)
    const run: InstallRunner = async () => { throw 'plain string failure' }
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store, run },
    )
    await completion
    const final = store.current()
    expect(final?.status).toBe('failed')
    expect(final?.log).toContain('[error] plain string failure')
  })
})

describe('UpdateJobStore events + index', () => {
  const running = { jobId: 'current', status: 'running' as const, targetVersion: '1.4.2', startedAt: 't0', log: '' }

  it('notifies registered listeners on save and stops after offEvent', () => {
    const store = new UpdateJobStore(logsDir)
    const events: { kind: string }[] = []
    const listener = (e: { kind: string }) => events.push(e)
    store.onEvent(listener)
    store.save(running)
    expect(events).toEqual([{ kind: 'changed' }])
    // The save also wrote an index row (exercises indexEntryOf).
    expect(store.current()?.status).toBe('running')

    store.offEvent(listener)
    store.save({ ...running, log: 'more output' })
    expect(events).toHaveLength(1) // no further events after offEvent
  })

  it('a throwing listener does not break persistence', () => {
    const store = new UpdateJobStore(logsDir)
    store.onEvent(() => { throw new Error('bad listener') })
    expect(() => store.save(running)).not.toThrow()
    expect(store.current()?.status).toBe('running')
  })
})

describe('reconcileInterrupted', () => {
  it('flips a job left running by a dead process to aborted', () => {
    const store = new UpdateJobStore(logsDir)
    store.save({ jobId: 'current', status: 'running', targetVersion: '1.4.2', startedAt: 't0', log: '' })
    store.reconcileInterrupted(() => 't1')
    const after = store.current()
    expect(after?.status).toBe('aborted')
    expect(after?.endedAt).toBe('t1')
  })
})
