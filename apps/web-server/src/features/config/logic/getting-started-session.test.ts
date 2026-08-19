import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GettingStartedBusyError,
  GettingStartedSessionStore,
  type GettingStartedStatusResolver,
} from './getting-started-session'

let logsDir: string
let runStatus: string | null
let flightStatus: string | null
let changes: number

function resolver(): GettingStartedStatusResolver {
  return {
    run: () => runStatus,
    flight: () => flightStatus,
    isRunActive: (status) => ['queued', 'running', 'healing'].includes(status),
    isFlightActive: (status) => ['queued', 'running', 'waiting-for-approval'].includes(status),
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

afterEach(() => fs.rmSync(logsDir, { recursive: true, force: true }))

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
})
