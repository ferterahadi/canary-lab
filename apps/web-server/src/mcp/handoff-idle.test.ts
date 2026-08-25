import { describe, expect, it } from 'vitest'
import {
  HANDOFF_IDLE_MS,
  createHandOffContactLedger,
  forgetHandOffContact,
  handOffIdleAdvice,
  handOffIdleMs,
  handOffIdleReportFor,
  hasPolled,
  noteHandOffContact,
} from './handoff-idle'

const T0 = 1_800_000_000_000
const MIN = 60_000

describe('handOffIdleMs', () => {
  // The abandoned-on-arrival case: a client took the work and never came back,
  // so there is no contact to measure from and the park itself is the clock.
  it('measures from the park when the client never polled', () => {
    const ledger = createHandOffContactLedger()
    const idle = handOffIdleMs(ledger, { flightId: 'f1', handOffId: 'h1', parkedAtMs: T0, nowMs: T0 + 40 * MIN })
    expect(idle).toBe(40 * MIN)
  })

  it('measures from the last poll once the client has checked in', () => {
    const ledger = createHandOffContactLedger()
    noteHandOffContact(ledger, { flightId: 'f1', handOffId: 'h1', nowMs: T0 + 30 * MIN })
    const idle = handOffIdleMs(ledger, { flightId: 'f1', handOffId: 'h1', parkedAtMs: T0, nowMs: T0 + 35 * MIN })
    expect(idle).toBe(5 * MIN)
  })

  // A client working for hours is fine as long as it keeps checking in — which
  // the skill already tells it to do every ~10 minutes for an unrelated reason.
  it('never trips for a client polling on the documented cadence', () => {
    const ledger = createHandOffContactLedger()
    let now = T0
    for (let i = 0; i < 30; i++) {
      now += 10 * MIN
      expect(handOffIdleMs(ledger, { flightId: 'f1', handOffId: 'h1', parkedAtMs: T0, nowMs: now }))
        .toBeLessThan(HANDOFF_IDLE_MS)
      noteHandOffContact(ledger, { flightId: 'f1', handOffId: 'h1', nowMs: now })
    }
    expect(now - T0).toBeGreaterThan(HANDOFF_IDLE_MS)
  })

  // A re-asked step gets a fresh handOffId; inheriting the abandoned attempt's
  // contact would hide a second abandonment behind the first client's polling.
  it('does not carry contact across a new handOffId', () => {
    const ledger = createHandOffContactLedger()
    noteHandOffContact(ledger, { flightId: 'f1', handOffId: 'old', nowMs: T0 + 40 * MIN })
    const idle = handOffIdleMs(ledger, { flightId: 'f1', handOffId: 'new', parkedAtMs: T0, nowMs: T0 + 41 * MIN })
    expect(idle).toBe(41 * MIN)
  })

  it('keeps separate clocks per flight', () => {
    const ledger = createHandOffContactLedger()
    noteHandOffContact(ledger, { flightId: 'f1', handOffId: 'h', nowMs: T0 + 40 * MIN })
    expect(handOffIdleMs(ledger, { flightId: 'f2', handOffId: 'h', parkedAtMs: T0, nowMs: T0 + 40 * MIN }))
      .toBe(40 * MIN)
  })

  // Clock skew, or a manifest written a hair in the future, must not read as a
  // negative idle that then reports as fresh forever.
  it('floors at zero', () => {
    const ledger = createHandOffContactLedger()
    expect(handOffIdleMs(ledger, { flightId: 'f1', parkedAtMs: T0 + MIN, nowMs: T0 })).toBe(0)
  })
})

describe('handOffIdleReportFor', () => {
  it('reports nothing while the hand-off is inside its budget', () => {
    expect(handOffIdleReportFor({ stage: 'docs', idleMs: HANDOFF_IDLE_MS - 1, everPolled: false })).toBeNull()
  })

  it('reports at the threshold', () => {
    const report = handOffIdleReportFor({ stage: 'docs', idleMs: HANDOFF_IDLE_MS, everPolled: false })
    expect(report).toEqual({ stage: 'docs', idleMinutes: 45, neverPolled: true })
  })

  it('distinguishes a client that polled once from one that never did', () => {
    const report = handOffIdleReportFor({ stage: 'portify', idleMs: 90 * MIN, everPolled: true })
    expect(report).toMatchObject({ stage: 'portify', idleMinutes: 90, neverPolled: false })
  })

  it('honours an injected threshold', () => {
    expect(handOffIdleReportFor({ stage: 'docs', idleMs: 2 * MIN, everPolled: false, thresholdMs: MIN }))
      .toMatchObject({ idleMinutes: 2 })
  })
})

describe('handOffIdleAdvice', () => {
  // The advice is read by whoever arrives NEXT — usually a fresh session that
  // inherited an abandoned flight. It has to say that the step is still
  // answerable, or the reader concludes the work is lost and restarts the stage.
  it('says the hand-off is still answerable and names the cause', () => {
    const advice = handOffIdleAdvice({ stage: 'docs', idleMinutes: 47, neverPolled: true })
    expect(advice).toContain('STALLED HAND-OFF')
    expect(advice).toContain('docs')
    expect(advice).toContain('47 minutes')
    expect(advice).toContain('ended its turn')
    expect(advice).toContain('still answerable')
    expect(advice).toContain('nothing will resume it')
  })

  it('distinguishes the two ways a hand-off goes quiet', () => {
    expect(handOffIdleAdvice({ stage: 'docs', idleMinutes: 50, neverPolled: true }))
      .toContain('no client has checked in on it since it parked')
    expect(handOffIdleAdvice({ stage: 'docs', idleMinutes: 50, neverPolled: false }))
      .toContain('has not checked in for 50 minutes')
  })
})

describe('forgetHandOffContact', () => {
  it('drops every hand-off of one flight and leaves the others', () => {
    const ledger = createHandOffContactLedger()
    noteHandOffContact(ledger, { flightId: 'f1', handOffId: 'a', nowMs: T0 })
    noteHandOffContact(ledger, { flightId: 'f1', handOffId: 'b', nowMs: T0 })
    noteHandOffContact(ledger, { flightId: 'f2', handOffId: 'a', nowMs: T0 })

    forgetHandOffContact(ledger, 'f1')

    expect(hasPolled(ledger, 'f1', 'a')).toBe(false)
    expect(hasPolled(ledger, 'f1', 'b')).toBe(false)
    expect(hasPolled(ledger, 'f2', 'a')).toBe(true)
  })

  it('is a no-op for a flight with no record', () => {
    const ledger = createHandOffContactLedger()
    expect(() => forgetHandOffContact(ledger, 'nope')).not.toThrow()
  })

  it('tracks a hand-off with no id', () => {
    const ledger = createHandOffContactLedger()
    expect(hasPolled(ledger, 'f1')).toBe(false)
    noteHandOffContact(ledger, { flightId: 'f1', nowMs: T0 })
    expect(hasPolled(ledger, 'f1')).toBe(true)
  })
})
