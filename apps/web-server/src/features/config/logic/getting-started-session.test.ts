import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GettingStartedBusyError,
  GettingStartedSessionStore,
  isGettingStartedRunActive,
  type GettingStartedStatusResolver,
} from './getting-started-session'

let logsDir: string
let runStatus: string | null
let flightStatus: string | null
let changes: number

function resolver(): GettingStartedStatusResolver {
  return {
    status: (target) => (target.kind === 'flight' ? flightStatus : runStatus),
    isActive: (target, status) => target.kind === 'flight'
      ? ['queued', 'running', 'waiting-for-approval'].includes(status)
      : ['queued', 'running', 'healing'].includes(status),
  }
}

function store(setTimer?: (fn: () => void, ms: number) => void): GettingStartedSessionStore {
  return new GettingStartedSessionStore(
    logsDir,
    resolver(),
    () => { changes += 1 },
    () => '2026-08-19T00:00:00.000Z',
    setTimer,
  )
}

beforeEach(() => {
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-getting-started-'))
  runStatus = null
  flightStatus = null
  changes = 0
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(logsDir, { recursive: true, force: true })
})

const sessionFile = (): string => path.join(logsDir, 'getting-started', 'session.json')

describe('GettingStartedSessionStore', () => {
  it('allows one owner and returns a typed conflict to every competitor', () => {
    const sessions = store()
    const active = sessions.claim('run', 'internal')
    expect(() => sessions.claim('flight', 'external')).toThrow(GettingStartedBusyError)
    try {
      sessions.claim('flight', 'external')
    } catch (error) {
      expect(error).toMatchObject({ type: 'getting_started_busy', active })
    }
  })

  it('persists the target and releases only when real run evidence is terminal', () => {
    const sessions = store()
    const claim = sessions.claim('run', 'external')
    runStatus = 'running'
    sessions.attach(claim.sessionId, { kind: 'run', id: 'run-1' })
    expect(store().read().active).toMatchObject({ owner: 'external', target: { kind: 'run', id: 'run-1' } })

    runStatus = 'passed'
    expect(sessions.read()).toMatchObject({
      active: null,
      completed: { run: { owner: 'external', status: 'passed', target: { kind: 'run', id: 'run-1' } } },
    })
  })

  it('keeps completed demo evidence while another workflow later runs', () => {
    const sessions = store()
    const run = sessions.claim('run', 'internal')
    runStatus = 'aborted'
    sessions.attach(run.sessionId, { kind: 'run', id: 'run-1' })
    sessions.reconcile()

    const flight = sessions.claim('flight', 'internal')
    flightStatus = 'completed'
    sessions.attach(flight.sessionId, { kind: 'flight', id: 'fl-1' })
    sessions.reconcile()
    expect(sessions.read().completed).toMatchObject({
      run: { status: 'aborted' },
      flight: { status: 'completed' },
    })
  })

  it('clears a crash-interrupted claim that never created a target', () => {
    const sessions = store()
    sessions.claim('flight', 'internal')
    store().reconcileInterrupted()
    expect(sessions.read().active).toBeNull()
  })

  it('abandons a failed start without erasing prior completion evidence', () => {
    const sessions = store()
    const first = sessions.claim('run', 'internal')
    runStatus = 'passed'
    sessions.attach(first.sessionId, { kind: 'run', id: 'run-1' })
    sessions.reconcile()
    const second = sessions.claim('flight', 'internal')
    sessions.abandon(second.sessionId)
    expect(sessions.read()).toMatchObject({ active: null, completed: { run: { status: 'passed' } } })
  })

  it('announces claims, targets, and terminal transitions to the workspace', () => {
    const sessions = store()
    const claim = sessions.claim('run', 'internal')
    runStatus = 'running'
    sessions.attach(claim.sessionId, { kind: 'run', id: 'r' })
    runStatus = 'aborted'
    sessions.reconcile()
    expect(changes).toBe(3)
  })

  it('does not release during the failed-to-healing auto-heal transition', () => {
    const timers: Array<() => void> = []
    const sessions = store((fn) => { timers.push(fn) })
    const claim = sessions.claim('run', 'internal')
    runStatus = 'failed'
    sessions.attach(claim.sessionId, { kind: 'run', id: 'r' })
    expect(sessions.read().active?.sessionId).toBe(claim.sessionId)
    expect(timers).toHaveLength(1)

    runStatus = 'healing'
    timers.shift()?.()
    expect(sessions.read().active?.sessionId).toBe(claim.sessionId)

    runStatus = 'failed'
    sessions.reconcile()
    timers.shift()?.()
    expect(sessions.read()).toMatchObject({
      active: null,
      completed: { run: { status: 'failed', target: { kind: 'run', id: 'r' } } },
    })
  })

  it('schedules one recheck per failed session, however often it is reconciled', () => {
    const timers: Array<() => void> = []
    const sessions = store((fn) => { timers.push(fn) })
    const claim = sessions.claim('run', 'internal')
    runStatus = 'failed'
    sessions.attach(claim.sessionId, { kind: 'run', id: 'r' })
    sessions.read()
    expect(timers).toHaveLength(1)

    // Every UI poll calls read() → reconcile(). Without the pending-set guard
    // each one would arm another 500ms timer for the same session.
    sessions.read()
    sessions.reconcile()

    expect(timers).toHaveLength(1)
  })

  it('rechecks a failed run on a real unref\'d timer when none is injected', async () => {
    vi.useFakeTimers()
    // The production server omits setTimer, so this is the only test that
    // exercises the module's own setTimeout(...).unref() default.
    const sessions = store()
    const claim = sessions.claim('run', 'internal')
    runStatus = 'failed'
    sessions.attach(claim.sessionId, { kind: 'run', id: 'r' })
    expect(sessions.read().active?.sessionId).toBe(claim.sessionId)

    await vi.advanceTimersByTimeAsync(500)

    expect(sessions.read()).toMatchObject({
      active: null,
      completed: { run: { status: 'failed' } },
    })
  })

  it('settles a target that vanished out-of-band as missing', () => {
    const sessions = store()
    const claim = sessions.claim('run', 'internal')
    runStatus = 'running'
    sessions.attach(claim.sessionId, { kind: 'run', id: 'r' })

    // Logs cleanup deleted the run record; the resolver has nothing to report.
    runStatus = null

    expect(sessions.read()).toMatchObject({
      active: null,
      completed: { run: { status: 'missing', target: { kind: 'run', id: 'r' } } },
    })
  })

  it('ignores attach and abandon for a session that no longer holds the claim', () => {
    const sessions = store()

    sessions.attach('gs-stale', { kind: 'run', id: 'r' })
    sessions.abandon('gs-stale')

    expect(sessions.read()).toMatchObject({ active: null, completed: {} })
    expect(changes).toBe(0)
  })

  it('reads a state file written before the completed map existed', () => {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true })
    fs.writeFileSync(sessionFile(), JSON.stringify({ active: null }), 'utf8')

    expect(store().read()).toEqual({ active: null, completed: {} })
  })
})

describe('isGettingStartedRunActive', () => {
  // This is the predicate server.ts wires as the resolver's isRunActive. The
  // fake resolvers above already count 'queued' as active — this pins the REAL
  // wiring to the same intent, so the prod/test mismatch that settled a queued
  // demo as "completed: queued" (dropping the one-demo lock mid-run) cannot
  // come back.
  it('counts a queued run as still active — the budget can park a start unasked', () => {
    expect(isGettingStartedRunActive('queued')).toBe(true)
    expect(isGettingStartedRunActive('running')).toBe(true)
    expect(isGettingStartedRunActive('healing')).toBe(true)
  })

  it('lets terminal statuses settle', () => {
    for (const status of ['passed', 'failed', 'aborted']) {
      expect(isGettingStartedRunActive(status)).toBe(false)
    }
  })
})
