import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  UpdateJobStore,
  startUpdateJob,
  UpdateJobConflictError,
  type InstallRunner,
} from './update-job'

let logsDir: string

beforeEach(() => {
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-update-job-'))
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
