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

import { bridgeStoreEvents } from '../../../shared/store-event-bridge'
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

function writeInstalledCli(root: string, packageName = 'canary-lab'): string {
  const packageRoot = path.join(root, 'node_modules', packageName)
  const cliPath = path.join(packageRoot, 'dist', 'apps', 'cli', 'cli.js')
  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  fs.writeFileSync(cliPath, '')
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: packageName, bin: { 'canary-lab': 'dist/apps/cli/cli.js' } }),
  )
  return cliPath
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
  it('marks the job done on a zero exit code and emits version-changed once it settles', async () => {
    const store = new UpdateJobStore(logsDir)
    const bus = collectEvents()
    // The job record is the emitter (shared/store-event-bridge.ts, wired in
    // routes/version.ts) — bridged here the same way, so this proves the chain
    // the server actually runs rather than a publish call inside the runner.
    bridgeStoreEvents(store, bus, () => store.current()?.status === 'running' ? null : { type: 'version-changed' })
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
    // Exactly one: the start and every chunk of npm output also write the
    // record, and broadcasting those would make every client refetch
    // /api/version dozens of times per install.
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
  it('installs, runs the newly installed upgrade CLI, and finishes only after both succeed', async () => {
    const store = new UpdateJobStore(logsDir)
    const cliPath = writeInstalledCli(logsDir)
    const installChild = new FakeChild()
    const upgradeChild = new FakeChild()
    spawnMock.mockReturnValueOnce(installChild).mockReturnValueOnce(upgradeChild)
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store }, // no `run` -> defaultInstall
    )
    expect(spawnMock).toHaveBeenCalledWith('npm', ['install', 'canary-lab@latest'], {
      cwd: logsDir,
      env: process.env,
    })
    installChild.stdout.emit('data', Buffer.from('added 1 package\n'))
    installChild.stderr.emit('data', Buffer.from('npm warn deprecated\n'))
    installChild.emit('close', 0)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    expect(spawnMock).toHaveBeenLastCalledWith(process.execPath, [cliPath, 'upgrade', '--silent'], {
      cwd: logsDir,
      env: process.env,
    })
    upgradeChild.stdout.emit('data', Buffer.from('workspace refreshed\n'))
    upgradeChild.emit('close', 0)
    await completion
    const final = store.current()
    expect(final?.status).toBe('done')
    expect(final?.log).toContain('added 1 package')
    expect(final?.log).toContain('npm warn deprecated')
    expect(final?.log).toContain('workspace refreshed')
    expect(final?.log).toContain('[upgrade]')
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

  it('fails instead of claiming completion when the installed CLI cannot be resolved', async () => {
    const store = new UpdateJobStore(logsDir)
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store },
    )
    child.emit('close', 0)
    await completion
    expect(store.current()?.status).toBe('failed')
    expect(store.current()?.log).toContain('could not find the installed canary-lab CLI')
  })

  it('fails when workspace migration fails after a successful package install', async () => {
    const store = new UpdateJobStore(logsDir)
    writeInstalledCli(logsDir)
    const installChild = new FakeChild()
    const upgradeChild = new FakeChild()
    spawnMock.mockReturnValueOnce(installChild).mockReturnValueOnce(upgradeChild)
    const { completion } = startUpdateJob(
      { projectRoot: logsDir, packageName: 'canary-lab', targetVersion: '1.4.2' },
      { store },
    )
    installChild.emit('close', 0)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    upgradeChild.stderr.emit('data', Buffer.from('migration failed\n'))
    upgradeChild.emit('close', 2)
    await completion
    expect(store.current()?.status).toBe('failed')
    expect(store.current()?.error).toContain('code 2')
    expect(store.current()?.log).toContain('migration failed')
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
