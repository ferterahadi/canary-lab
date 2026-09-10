import { describe, expect, it } from 'vitest'
import { DEFAULT_SHRINK_OPTIONS, reproLine, sameAtResolution, shrinkEnvelope, type ShrinkProbe } from './shrink'
import { ROBUSTNESS_ENVELOPE_FORMAT, type RobustnessEnvelope } from './types'

const FORMAT = ROBUSTNESS_ENVELOPE_FORMAT

const FULL: RobustnessEnvelope = {
  format: FORMAT,
  latency: { ms: 300 },
  duplicate: { gapMs: 500, match: 'WRITE /**' },
  restart: [{ slot: 'catalog', afterNth: 2, match: 'WRITE /**' }, { slot: 'checkout', afterNth: 2, match: 'WRITE /**' }],
}

// A stand-in app: the finding needs a replayed write AND enough latency for the
// replay to land before the test reads (any gap will do); restarts are noise.
const timingDefect: ShrinkProbe = async (env) => env.duplicate !== undefined && (env.latency?.ms ?? 0) > 100

describe('shrinkEnvelope', () => {
  it('drops the atoms that do not matter, bisects the knobs that do, and confirms the result', async () => {
    const result = await shrinkEnvelope(FULL, timingDefect)
    expect(result.status).toBe('confirmed')
    expect(result.envelope).toEqual({ format: FORMAT, latency: { ms: 112 }, duplicate: { gapMs: 62, match: 'WRITE /**' } })
    expect(result.repro).toBe('latency 112 ms · duplicate WRITE /** after 62 ms')
    // Twelve search probes: two ddmin passes (4 + 2), three latency bisections,
    // then the gap bisection ran out of budget after three — and said so.
    expect(result.probes).toBe(12)
    expect(result.budgetExhausted).toBe(true)
    expect(result.confirmations).toEqual({ asked: 3, reproduced: 3 })
    expect(result.steps).toHaveLength(1 + 12 + 3)
    expect(result.steps[0]).toMatchObject({ probe: 0, reproduced: true, why: 'does the finding reproduce under the envelope it was found with?' })
    expect(result.steps.slice(1, 5).map((s) => s.why)).toEqual([
      'still reproduces without restart checkout on WRITE /** #2?',
      'still reproduces without restart catalog on WRITE /** #2?',
      'still reproduces without duplicate WRITE /** after 500 ms?',
      'still reproduces without latency 300 ms?',
    ])
    expect(result.steps[7]).toMatchObject({ probe: 7, reproduced: true, why: 'still reproduces with latency at 150 ms?' })
    expect(result.steps[10]).toMatchObject({ probe: 10, why: 'still reproduces with the duplicate 250 ms after the original?' })
    expect(result.steps.at(-1)).toMatchObject({ probe: 0, why: 'replay 3 of 3 of the shrunk envelope' })
  })

  it('keeps a restart-only finding on the one slot that matters and has no knob to bisect', async () => {
    const result = await shrinkEnvelope(FULL, async (env) => (env.restart ?? []).some((r) => r.slot === 'checkout'))
    expect(result.status).toBe('confirmed')
    expect(result.envelope).toEqual({ format: FORMAT, restart: [{ slot: 'checkout', afterNth: 2, match: 'WRITE /**' }] })
    expect(result.repro).toBe('restart checkout on WRITE /** #2')
    // Pass 1 keeps checkout and drops catalog, duplicate and latency (4 probes); pass 2 re-asks about checkout (1).
    expect(result.probes).toBe(5)
    expect(result.budgetExhausted).toBe(false)
  })

  it('stops the atom search where the budget runs out and still confirms what it has', async () => {
    const result = await shrinkEnvelope(FULL, timingDefect, { maxProbes: 2 })
    expect(result.probes).toBe(2)
    expect(result.budgetExhausted).toBe(true)
    expect(result.status).toBe('confirmed')
    // The two probes dropped the two restarts; no knob moved. The answer is
    // what the search had, honestly labelled.
    expect(result.envelope).toEqual({ format: FORMAT, latency: { ms: 300 }, duplicate: { gapMs: 500, match: 'WRITE /**' } })
    expect(result.repro).toBe('latency 300 ms · duplicate WRITE /** after 500 ms')
  })

  it('keeps the lighter atom when either a restart or latency alone would do', async () => {
    // A cart TTL shorter than one delayed round trip AND shorter than a reboot:
    // both atoms expose it, and the repro should not ask for a restart.
    const result = await shrinkEnvelope(FULL, async (env) => (env.latency?.ms ?? 0) > 150 || (env.restart ?? []).some((r) => r.slot === 'checkout'))
    expect(result.envelope).toEqual({ format: FORMAT, latency: { ms: 187 } })
    expect(result.repro).toBe('latency 187 ms')
  })

  it('reports a finding that does not reproduce even once as not-reproduced, without searching', async () => {
    const result = await shrinkEnvelope(FULL, async () => false)
    expect(result).toMatchObject({ status: 'not-reproduced', envelope: FULL, probes: 0, budgetExhausted: false, confirmations: { asked: 0, reproduced: 0 } })
    expect(result.steps).toHaveLength(1)
  })

  it('calls a shrunk envelope unconfirmed when any replay fails to reproduce', async () => {
    let calls = 0
    const flaky: ShrinkProbe = async (env) => {
      calls++
      return calls !== 8 && env.latency !== undefined
    }
    const result = await shrinkEnvelope({ format: FORMAT, latency: { ms: 300 } }, flaky, { confirmations: 3, minStepMs: 50 })
    expect(result.envelope).toEqual({ format: FORMAT, latency: { ms: 37 } })
    expect(result.probes).toBe(4)
    expect(result.confirmations).toEqual({ asked: 3, reproduced: 2 })
    expect(result.status).toBe('unconfirmed')
  })

  it('bisects at the requested resolution', async () => {
    const result = await shrinkEnvelope({ format: FORMAT, latency: { ms: 300 } }, async (env) => (env.latency?.ms ?? 0) > 100, { minStepMs: 10 })
    expect(result.envelope.latency).toEqual({ ms: 102 })
    expect(DEFAULT_SHRINK_OPTIONS).toEqual({ maxProbes: 12, confirmations: 3, minStepMs: 50 })
  })
})

describe('sameAtResolution', () => {
  const base: RobustnessEnvelope = { format: FORMAT, latency: { ms: 112 }, duplicate: { gapMs: 62, match: 'WRITE /**' }, restart: [{ slot: 'checkout', afterNth: 2, match: 'WRITE /**' }] }

  it('agrees when the atoms match and every knob sits within one step', () => {
    expect(sameAtResolution(base, base)).toBe(true)
    expect(sameAtResolution(base, { ...base, latency: { ms: 150 }, duplicate: { gapMs: 31, match: 'WRITE /**' } })).toBe(true)
    expect(sameAtResolution({ format: FORMAT, restart: base.restart }, { format: FORMAT, restart: base.restart })).toBe(true)
    expect(sameAtResolution({ format: FORMAT, latency: { ms: 112 } }, { format: FORMAT, latency: { ms: 130 } })).toBe(true)
  })

  it('disagrees on a different atom set', () => {
    expect(sameAtResolution(base, { format: FORMAT, latency: { ms: 112 } })).toBe(false)
    expect(sameAtResolution({ format: FORMAT, latency: { ms: 112 } }, { format: FORMAT, duplicate: { gapMs: 62, match: 'WRITE /**' } })).toBe(false)
  })

  it('disagrees when a knob moved more than a step, or a match or position changed', () => {
    expect(sameAtResolution(base, { ...base, latency: { ms: 200 } })).toBe(false)
    expect(sameAtResolution(base, { ...base, latency: { ms: 200 } }, 100)).toBe(true)
    expect(sameAtResolution(base, { ...base, duplicate: { gapMs: 62, match: 'POST /carts/**' } })).toBe(false)
    expect(sameAtResolution(base, { ...base, duplicate: { gapMs: 200, match: 'WRITE /**' } })).toBe(false)
    expect(sameAtResolution(base, { ...base, restart: [{ slot: 'checkout', afterNth: 3, match: 'WRITE /**' }] })).toBe(false)
    expect(sameAtResolution(base, { ...base, restart: [{ slot: 'checkout', afterNth: 2, match: 'POST /**' }] })).toBe(false)
  })
})

describe('reproLine', () => {
  it('names every kept atom in envelope order, or says there is none', () => {
    expect(reproLine(FULL)).toBe('latency 300 ms · duplicate WRITE /** after 500 ms · restart catalog on WRITE /** #2 · restart checkout on WRITE /** #2')
    expect(reproLine({ format: FORMAT })).toBe('no perturbation')
  })
})
