import { describe, it, expect } from 'vitest'
import { HealCycleState, AUTO_HEAL_MAX_CYCLES } from './heal-cycle'

describe('HealCycleState.observeFailures', () => {
  it('returns shouldHeal=false when signature is empty', () => {
    const s = new HealCycleState()
    expect(s.observeFailures('')).toEqual({ shouldHeal: false })
  })

  it('agrees to heal on first failure', () => {
    const s = new HealCycleState()
    expect(s.observeFailures('a|b')).toEqual({ shouldHeal: true })
  })

  it('caps at max cycles', () => {
    const s = new HealCycleState({ maxCycles: 2 })
    expect(s.observeFailures('a').shouldHeal).toBe(true)
    s.beginCycle()
    expect(s.observeFailures('b').shouldHeal).toBe(true)
    s.beginCycle()
    expect(s.observeFailures('c')).toEqual({ shouldHeal: false, reason: 'max-cycles' })
  })

  it('exposes a default max equal to the public constant', () => {
    expect(AUTO_HEAL_MAX_CYCLES).toBe(3)
    const s = new HealCycleState()
    for (let i = 0; i < AUTO_HEAL_MAX_CYCLES; i++) {
      expect(s.observeFailures(`sig-${i}`).shouldHeal).toBe(true)
      s.beginCycle()
    }
    expect(s.observeFailures('again').shouldHeal).toBe(false)
  })

  it('detects no-progress when same signature repeats past the cap', () => {
    // maxCycles is high so the cycle counter doesn't trip first; we simulate
    // the consecutive-failure check directly by NOT incrementing the cycle
    // between observations (i.e. multiple observations within one cycle).
    const s = new HealCycleState({ maxCycles: 100 })
    for (let i = 0; i < 100; i++) {
      expect(s.observeFailures('same').shouldHeal).toBe(true)
    }
    expect(s.observeFailures('same')).toEqual({ shouldHeal: false, reason: 'no-progress' })
  })

  it('resets streak when failure set changes', () => {
    const s = new HealCycleState({ maxCycles: 10 })
    s.observeFailures('a'); s.beginCycle()
    s.observeFailures('a'); s.beginCycle()
    const r = s.observeFailures('b')
    expect(r.shouldHeal).toBe(true)
    expect(s.snapshot().consecutiveSameFailures).toBe(1)
    expect(s.snapshot().lastFailureSignature).toBe('b')
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
