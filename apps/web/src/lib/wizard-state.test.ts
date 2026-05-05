import { describe, it, expect } from 'vitest'
import {
  canAdvance,
  isGenerationActive,
  isPollingForStep,
  isTerminalDraft,
  nextStepForStatus,
  terminalForStep,
  type DraftStatus,
  type WizardStep,
} from './wizard-state'

const ALL: DraftStatus[] = [
  'created',
  'recommending',
  'planning',
  'plan-ready',
  'generating',
  'spec-ready',
  'refining',
  'accepted',
  'rejected',
  'cancelled',
  'error',
]

describe('nextStepForStatus', () => {
  it('keeps configure for created/recommending', () => {
    expect(nextStepForStatus('created')).toBe('configure')
    expect(nextStepForStatus('recommending')).toBe('configure')
  })
  it('plan step covers planning + plan-ready', () => {
    expect(nextStepForStatus('planning')).toBe('plan')
    expect(nextStepForStatus('plan-ready')).toBe('plan')
  })
  it('spec step covers generating + spec-ready', () => {
    expect(nextStepForStatus('generating')).toBe('spec')
    expect(nextStepForStatus('spec-ready')).toBe('spec')
  })
  it('done for accepted', () => {
    expect(nextStepForStatus('accepted')).toBe('done')
  })
  it('falls back to configure for rejected/cancelled/error', () => {
    expect(nextStepForStatus('rejected')).toBe('configure')
    expect(nextStepForStatus('cancelled')).toBe('configure')
    expect(nextStepForStatus('error')).toBe('configure')
  })
})

describe('isPollingForStep', () => {
  it('plan polls only while planning', () => {
    expect(isPollingForStep('plan', 'planning')).toBe(true)
    expect(isPollingForStep('plan', 'plan-ready')).toBe(false)
    expect(isPollingForStep('plan', 'error')).toBe(false)
  })
  it('spec polls while generating or refining', () => {
    expect(isPollingForStep('spec', 'generating')).toBe(true)
    expect(isPollingForStep('spec', 'refining')).toBe(true)
    expect(isPollingForStep('spec', 'spec-ready')).toBe(false)
  })
  it('configure polls only while recommending', () => {
    expect(isPollingForStep('configure', 'recommending')).toBe(true)
    expect(isPollingForStep('configure', 'created')).toBe(false)
  })
  it('done never polls', () => {
    for (const s of ALL) expect(isPollingForStep('done', s)).toBe(false)
  })
})

describe('terminalForStep', () => {
  it('plan is terminal at plan-ready and after', () => {
    expect(terminalForStep('plan', 'planning')).toBe(false)
    expect(terminalForStep('plan', 'plan-ready')).toBe(true)
    expect(terminalForStep('plan', 'error')).toBe(true)
  })
  it('spec is terminal at spec-ready and after', () => {
    expect(terminalForStep('spec', 'generating')).toBe(false)
    expect(terminalForStep('spec', 'spec-ready')).toBe(true)
  })
  it('configure terminal at created (so user can submit)', () => {
    expect(terminalForStep('configure', 'created')).toBe(true)
    expect(terminalForStep('configure', 'recommending')).toBe(false)
  })
  it('done is terminal only at accepted/rejected/cancelled/error', () => {
    expect(terminalForStep('done', 'accepted')).toBe(true)
    expect(terminalForStep('done', 'rejected')).toBe(true)
    expect(terminalForStep('done', 'cancelled')).toBe(true)
    expect(terminalForStep('done', 'planning')).toBe(false)
  })
})

describe('canAdvance', () => {
  it('configure advances at created', () => {
    expect(canAdvance('created', 'configure')).toBe(true)
    expect(canAdvance('planning', 'configure')).toBe(false)
  })
  it('plan advances at plan-ready', () => {
    expect(canAdvance('plan-ready', 'plan')).toBe(true)
    expect(canAdvance('planning', 'plan')).toBe(false)
  })
  it('spec advances at spec-ready', () => {
    expect(canAdvance('spec-ready', 'spec')).toBe(true)
    expect(canAdvance('generating', 'spec')).toBe(false)
  })
  it('done never advances', () => {
    const steps: WizardStep[] = ['configure', 'plan', 'spec', 'done']
    for (const s of steps) {
      const result = canAdvance('accepted', s)
      // Only configure/plan/spec gate; done returns false.
      if (s === 'done') expect(result).toBe(false)
    }
  })
})

describe('isTerminalDraft', () => {
  it('flags accepted/rejected/cancelled/error', () => {
    expect(isTerminalDraft('accepted')).toBe(true)
    expect(isTerminalDraft('rejected')).toBe(true)
    expect(isTerminalDraft('cancelled')).toBe(true)
    expect(isTerminalDraft('error')).toBe(true)
  })
  it('returns false for in-progress states', () => {
    expect(isTerminalDraft('created')).toBe(false)
    expect(isTerminalDraft('planning')).toBe(false)
    expect(isTerminalDraft('spec-ready')).toBe(false)
  })
})

describe('isGenerationActive', () => {
  it('flags statuses backed by an active wizard agent', () => {
    expect(isGenerationActive('planning')).toBe(true)
    expect(isGenerationActive('generating')).toBe(true)
    expect(isGenerationActive('refining')).toBe(true)
  })

  it('returns false once the user can close safely', () => {
    expect(isGenerationActive('cancelled')).toBe(false)
    expect(isGenerationActive('error')).toBe(false)
    expect(isGenerationActive('spec-ready')).toBe(false)
  })
})
