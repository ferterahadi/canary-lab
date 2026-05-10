import { describe, it, expect } from 'vitest'
import {
  appendStep,
  parseActionsTextarea,
  parsePlanStepMarkdown,
  removeStep,
  renderActionsTextarea,
  renderPlanStepMarkdown,
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

describe('plan step markdown round-trip', () => {
  it('renders a step as editable markdown', () => {
    expect(renderPlanStepMarkdown(seed[1])).toBe([
      '# b',
      '',
      '## Action',
      '1. b1',
      '2. b2',
      '',
      '## Expectation',
      '1. ob',
    ].join('\n'))
  })

  it('renders fallback title, action, and expectation placeholders', () => {
    expect(renderPlanStepMarkdown({ step: '  ', actions: [], expectedOutcome: '  ' })).toBe([
      '# New step',
      '',
      '## Action',
      '1. ',
      '',
      '## Expectation',
      '1. ',
    ].join('\n'))
  })

  it('renders multi-line expectations while dropping blank expectation lines', () => {
    expect(renderPlanStepMarkdown({
      step: 'Checkout',
      actions: ['open cart'],
      expectedOutcome: 'summary visible\n\nvoucher visible  ',
    })).toContain('1. summary visible\n2. voucher visible')
  })

  it('parses markdown back into a plan step', () => {
    const parsed = parsePlanStepMarkdown([
      '# Open checkout',
      '',
      '## Action',
      '1. Sign in',
      '2. Open checkout',
      '',
      '## Expectation',
      '1. Order summary renders',
      '2. Voucher section is visible',
    ].join('\n'))

    expect(parsed).toEqual({
      step: 'Open checkout',
      actions: ['Sign in', 'Open checkout'],
      expectedOutcome: 'Order summary renders\nVoucher section is visible',
    })
  })

  it('treats blank bullets as empty content', () => {
    expect(parsePlanStepMarkdown('# Title\n\n## Action\n1. \n\n## Expectation\n1. ')).toEqual({
      step: 'Title',
      actions: [],
      expectedOutcome: '',
    })
  })

  it('ignores unknown sections and keeps the first title', () => {
    expect(parsePlanStepMarkdown([
      '# First title',
      '# Ignored title',
      '## Notes',
      '1. ignored',
      '## Action',
      '1. Click pay',
      '## Expectation',
      '1. Payment succeeds',
    ].join('\n'))).toEqual({
      step: 'First title',
      actions: ['Click pay'],
      expectedOutcome: 'Payment succeeds',
    })
  })
})
