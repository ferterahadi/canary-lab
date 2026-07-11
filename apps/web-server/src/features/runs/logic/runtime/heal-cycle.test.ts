import { describe, it, expect } from 'vitest'
import { HealCycleState, AUTO_HEAL_MAX_CYCLES, DEFAULT_NO_PROGRESS_LIMIT } from './heal-cycle'

describe('HealCycleState.observeFailures', () => {
  it('returns shouldHeal=false when slug list is empty', () => {
    const s = new HealCycleState()
    expect(s.observeFailures([])).toEqual({ shouldHeal: false })
  })

  it('agrees to heal on first failure', () => {
    const s = new HealCycleState()
    expect(s.observeFailures(['a', 'b'])).toEqual({ shouldHeal: true })
  })

  it('caps at max cycles', () => {
    const s = new HealCycleState({ maxCycles: 2 })
    expect(s.observeFailures(['a']).shouldHeal).toBe(true)
    s.beginCycle()
    expect(s.observeFailures(['b']).shouldHeal).toBe(true)
    s.beginCycle()
    expect(s.observeFailures(['c'])).toEqual({ shouldHeal: false, reason: 'max-cycles' })
  })

  it('caps cycles at a finite default', () => {
    expect(AUTO_HEAL_MAX_CYCLES).toBe(10)
    const s = new HealCycleState()
    // Distinct failure sets each cycle so the no-progress guard never trips —
    // only the cycle cap should end the loop.
    for (let i = 0; i < AUTO_HEAL_MAX_CYCLES; i++) {
      expect(s.observeFailures([`sig-${i}`]).shouldHeal).toBe(true)
      s.beginCycle()
    }
    expect(s.observeFailures(['again'])).toEqual({ shouldHeal: false, reason: 'max-cycles' })
  })

  it('detects no-progress when the same signature repeats past the limit', () => {
    // maxCycles is high so the cycle counter doesn't trip first. The default
    // no-progress limit is min(maxCycles, DEFAULT_NO_PROGRESS_LIMIT): that
    // many consecutive identical observations still heal; the next gives up.
    const s = new HealCycleState({ maxCycles: 100 })
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LIMIT; i++) {
      expect(s.observeFailures(['same']).shouldHeal).toBe(true)
    }
    expect(s.observeFailures(['same'])).toEqual({ shouldHeal: false, reason: 'no-progress' })
  })

  it('honors an explicit noProgressLimit', () => {
    const s = new HealCycleState({ maxCycles: 100, noProgressLimit: 2 })
    expect(s.observeFailures(['same']).shouldHeal).toBe(true)
    expect(s.observeFailures(['same']).shouldHeal).toBe(true)
    expect(s.observeFailures(['same'])).toEqual({ shouldHeal: false, reason: 'no-progress' })
  })

  it('tracks per-slug streaks that survive set churn', () => {
    const s = new HealCycleState({ maxCycles: 100 })
    s.observeFailures(['a', 'b', 'flaky'])
    s.observeFailures(['a', 'b'])          // flaky recovered — set signature changed
    s.observeFailures(['a', 'b', 'other']) // a new test joined — signature changed again
    // Set-identity streak reset each time…
    expect(s.snapshot().consecutiveSameFailures).toBe(1)
    // …but a and b have failed 3 observations in a row: stuck.
    expect(s.stuckSlugs(3)).toEqual(['a', 'b'])
    expect(s.snapshot().maxSlugStreak).toBe(3)
  })

  it('resets a per-slug streak when the test recovers and later fails again', () => {
    const s = new HealCycleState({ maxCycles: 100 })
    s.observeFailures(['a', 'b'])
    s.observeFailures(['b'])       // a recovered
    s.observeFailures(['a', 'b'])  // a is back — streak restarts at 1
    expect(s.stuckSlugs(3)).toEqual(['b'])
    expect(s.snapshot().maxSlugStreak).toBe(3)
  })

  it('resets streak when failure set changes', () => {
    const s = new HealCycleState({ maxCycles: 10 })
    s.observeFailures(['a']); s.beginCycle()
    s.observeFailures(['a']); s.beginCycle()
    const r = s.observeFailures(['b'])
    expect(r.shouldHeal).toBe(true)
    expect(s.snapshot().consecutiveSameFailures).toBe(1)
    expect(s.snapshot().lastFailureSignature).toBe('b')
  })

  it('treats slug ordering as irrelevant for the signature (no spurious progress)', () => {
    const s = new HealCycleState()
    s.observeFailures(['a', 'b']); s.beginCycle()
    s.observeFailures(['b', 'a']); s.beginCycle()
    expect(s.snapshot().consecutiveSameFailures).toBe(2)
  })

  it('remembers the slug list on snapshot.lastFailingSlugs in caller order', () => {
    const s = new HealCycleState()
    expect(s.snapshot().lastFailingSlugs).toEqual([])
    s.observeFailures(['z', 'a', 'm'])
    expect(s.snapshot().lastFailingSlugs).toEqual(['z', 'a', 'm'])
  })

  it('lastFailingSlugs reflects the most recent observation', () => {
    const s = new HealCycleState()
    s.observeFailures(['a', 'b']); s.beginCycle()
    s.observeFailures(['c'])
    expect(s.snapshot().lastFailingSlugs).toEqual(['c'])
  })

  it('snapshot returns a defensive slug copy (caller cannot mutate state)', () => {
    const s = new HealCycleState()
    s.observeFailures(['a'])
    const snap = s.snapshot()
    snap.lastFailingSlugs.push('mutated')
    expect(s.snapshot().lastFailingSlugs).toEqual(['a'])
  })

  it('does not update lastFailingSlugs on an empty-slug call (leaves prior state)', () => {
    const s = new HealCycleState()
    s.observeFailures(['a', 'b'])
    s.observeFailures([]) // empty: early return, no update
    expect(s.snapshot().lastFailingSlugs).toEqual(['a', 'b'])
  })

  it('stuckSlugs excludes a currently-failing slug whose streak is below threshold', () => {
    const s = new HealCycleState({ maxCycles: 100 })
    s.observeFailures(['a', 'b'])
    s.observeFailures(['a', 'b', 'fresh']) // fresh has streak 1, a/b have streak 2
    expect(s.stuckSlugs(2)).toEqual(['a', 'b'])
  })

  it('snapshot maxSlugStreak keeps the running max when a later slug streak is smaller', () => {
    const s = new HealCycleState({ maxCycles: 100 })
    s.observeFailures(['a', 'b'])
    s.observeFailures(['a', 'b'])
    s.observeFailures(['a', 'b', 'fresh']) // a/b streak 3, fresh streak 1 — max stays 3
    expect(s.snapshot().maxSlugStreak).toBe(3)
  })
})

describe('HealCycleState.actionForSignal', () => {
  it('maps restart to restart-and-rerun', () => {
    const s = new HealCycleState()
    expect(s.actionForSignal('restart')).toEqual({ kind: 'restart-and-rerun' })
  })

  it('maps rerun to rerun-only', () => {
    const s = new HealCycleState()
    expect(s.actionForSignal('rerun')).toEqual({ kind: 'rerun-only' })
  })

  it('actionForNoSignal gives up with no-progress', () => {
    const s = new HealCycleState()
    expect(s.actionForNoSignal()).toEqual({ kind: 'give-up', reason: 'no-progress' })
  })
})

describe('HealCycleState.beginCycle / snapshot', () => {
  it('returns the in-flight cycle number then increments', () => {
    const s = new HealCycleState()
    expect(s.beginCycle()).toBe(0)
    expect(s.beginCycle()).toBe(1)
    expect(s.snapshot().cycle).toBe(2)
  })
})
