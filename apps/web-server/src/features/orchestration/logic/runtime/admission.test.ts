import { describe, expect, it } from 'vitest'
import {
  computeSlotBudget,
  decideAdmission,
  estimateRunCost,
  resolveAdmissionConfig,
  type AdmissionConfig,
  type SystemResources,
} from './admission'

const GB = 1024 * 1024 * 1024
const heuristicOnly: AdmissionConfig = { maxConcurrentRuns: null, perRunMemBytes: 768 * 1024 * 1024 }
const bigBox: SystemResources = { cpuCount: 16, freeMemBytes: 32 * GB }

describe('resolveAdmissionConfig', () => {
  it('reads a positive CANARY_MAX_CONCURRENT_RUNS ceiling', () => {
    expect(resolveAdmissionConfig({ CANARY_MAX_CONCURRENT_RUNS: '3' }).maxConcurrentRuns).toBe(3)
  })
  it('falls back to null on missing/invalid values', () => {
    expect(resolveAdmissionConfig({}).maxConcurrentRuns).toBeNull()
    expect(resolveAdmissionConfig({ CANARY_MAX_CONCURRENT_RUNS: 'nope' }).maxConcurrentRuns).toBeNull()
    expect(resolveAdmissionConfig({ CANARY_MAX_CONCURRENT_RUNS: '0' }).maxConcurrentRuns).toBeNull()
  })
})

describe('computeSlotBudget', () => {
  it('takes the tighter of the CPU and memory bounds', () => {
    // CPU bound: 16 - 1 = 15; mem bound: 32GB / 768MB ≈ 42 → min = 15.
    expect(computeSlotBudget(bigBox, heuristicOnly)).toBe(15)
    // Memory-starved: 1GB free / 768MB = 1 slot.
    expect(computeSlotBudget({ cpuCount: 16, freeMemBytes: 1 * GB }, heuristicOnly)).toBe(1)
  })
  it('never drops below 1', () => {
    expect(computeSlotBudget({ cpuCount: 1, freeMemBytes: 0 }, heuristicOnly)).toBe(1)
  })
})

describe('estimateRunCost', () => {
  it('is service count plus the playwright runner', () => {
    expect(estimateRunCost(2)).toBe(3)
    expect(estimateRunCost(0)).toBe(1)
  })
})

describe('decideAdmission', () => {
  it('always admits when nothing else is active, even a large run', () => {
    expect(decideAdmission({ activeCosts: [], candidateCost: 99, resources: { cpuCount: 2, freeMemBytes: GB }, config: heuristicOnly }))
      .toEqual({ admit: true })
  })

  it('admits within the slot budget and queues past it', () => {
    // budget 15. used 12, candidate 3 → 15 ≤ 15 admit.
    expect(decideAdmission({ activeCosts: [6, 6], candidateCost: 3, resources: bigBox, config: heuristicOnly }).admit).toBe(true)
    // used 14, candidate 3 → 17 > 15 queue.
    expect(decideAdmission({ activeCosts: [7, 7], candidateCost: 3, resources: bigBox, config: heuristicOnly }))
      .toEqual({ admit: false, reason: 'resources' })
  })

  it('honors the manual ceiling regardless of resources', () => {
    const config: AdmissionConfig = { maxConcurrentRuns: 2, perRunMemBytes: 768 * 1024 * 1024 }
    // Two already active → a third is refused even on a huge box.
    expect(decideAdmission({ activeCosts: [1, 1], candidateCost: 1, resources: bigBox, config }))
      .toEqual({ admit: false, reason: 'resources' })
    // One active → second allowed.
    expect(decideAdmission({ activeCosts: [1], candidateCost: 1, resources: bigBox, config }).admit).toBe(true)
  })
})
