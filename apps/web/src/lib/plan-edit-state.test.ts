import { describe, it, expect } from 'vitest'
import {
  appendStep,
  parseActionsTextarea,
  removeStep,
  renderActionsTextarea,
  reorderStep,
  updateStep,
  validatePlan,
} from './plan-edit-state'
import type { PlanStep } from '../api/types'

const seed: PlanStep[] = [
  { step: 'a', actions: ['a1'], expectedOutcome: 'oa' },
  { step: 'b', actions: ['b1', 'b2'], expectedOutcome: 'ob' },
  { step: 'c', actions: [], expectedOutcome: 'oc' },
]

describe('reorderStep', () => {
  it('moves an item forward', () => {
    const out = reorderStep(seed, 0, 2)
    expect(out.map((s) => s.step)).toEqual(['b', 'c', 'a'])
  })
  it('moves an item backward', () => {
    const out = reorderStep(seed, 2, 0)
    expect(out.map((s) => s.step)).toEqual(['c', 'a', 'b'])
  })
  it('returns same plan when from === to', () => {
    expect(reorderStep(seed, 1, 1)).toBe(seed)
  })
  it('returns same plan when from out of bounds', () => {
    expect(reorderStep(seed, -1, 0)).toBe(seed)
    expect(reorderStep(seed, 99, 0)).toBe(seed)
  })
  it('returns same plan when to out of bounds', () => {
    expect(reorderStep(seed, 0, -1)).toBe(seed)
    expect(reorderStep(seed, 0, 99)).toBe(seed)
  })
})

describe('removeStep', () => {
  it('removes an item by index', () => {
    expect(removeStep(seed, 1).map((s) => s.step)).toEqual(['a', 'c'])
  })
  it('removes the only item leaving an empty plan', () => {
    expect(removeStep([seed[0]], 0)).toEqual([])
  })
  it('ignores an out-of-bounds index', () => {
    expect(removeStep(seed, 99)).toBe(seed)
    expect(removeStep(seed, -1)).toBe(seed)
  })
})

describe('updateStep', () => {
  it('patches a step label', () => {
    const out = updateStep(seed, 0, { step: 'A!' })
    expect(out[0].step).toBe('A!')
    expect(out[0].actions).toEqual(['a1'])
  })
  it('patches actions array', () => {
    const out = updateStep(seed, 1, { actions: ['x'] })
    expect(out[1].actions).toEqual(['x'])
  })
  it('returns same plan when index OOB', () => {
    expect(updateStep(seed, 99, { step: 'no' })).toBe(seed)
  })
})

describe('appendStep', () => {
  it('appends a default step', () => {
    const out = appendStep(seed)
    expect(out).toHaveLength(seed.length + 1)
    expect(out[out.length - 1]).toEqual({ step: 'New step', actions: [], expectedOutcome: '' })
  })
})

describe('validatePlan', () => {
  it('passes a clean plan', () => {
    expect(validatePlan(seed)).toEqual([])
  })
  it('flags blank step labels', () => {
    const bad: PlanStep[] = [{ step: '   ', actions: [], expectedOutcome: '' }]
    const errs = validatePlan(bad)
    expect(errs).toHaveLength(1)
    expect(errs[0].field).toBe('step')
  })
  it('flags non-string step', () => {
    const bad = [{ step: undefined as unknown as string, actions: [], expectedOutcome: '' }]
    const errs = validatePlan(bad)
    expect(errs).toHaveLength(1)
  })
})

describe('actions textarea round-trip', () => {
  it('parses and re-renders losslessly modulo trailing space', () => {
    const text = 'do x\ndo y\n'
    const parsed = parseActionsTextarea(text)
    expect(parsed).toEqual(['do x', 'do y'])
    expect(renderActionsTextarea(parsed)).toBe('do x\ndo y')
  })
  it('drops blank lines', () => {
    expect(parseActionsTextarea('a\n\nb\n')).toEqual(['a', 'b'])
  })
})
