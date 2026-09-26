import { describe, expect, it } from 'vitest'
import type { FlightIndexEntry } from '@/shared/api/client'
import { coverageGeneratingFlight } from './workspace-flights'

const flight = (over: Partial<FlightIndexEntry> = {}): FlightIndexEntry => ({
  id: 'fl_1', flightId: 'fl_1', feature: 'checkout', repoPaths: [], status: 'running', currentStage: 'docs',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
})
describe('coverage generation in the workspace', () => {
  it('requires a selected suite and its active Flight', () => {
    expect(coverageGeneratingFlight([flight()], null)).toBeNull()
    expect(coverageGeneratingFlight([], 'checkout')).toBeNull()
    expect(coverageGeneratingFlight([flight({ feature: 'other' })], 'checkout')).toBeNull()
    for (const status of ['paused', 'done', 'failed', 'aborted'] as const) {
      expect(coverageGeneratingFlight([flight({ status })], 'checkout')).toBeNull()
    }
  })
  it.each(['docs', 'prd-summary', 'specs-coverage'] as const)('shows the %s stage with its presented status', (stage) => {
    expect(coverageGeneratingFlight([flight({ currentStage: stage, stages: [{ key: stage, status: 'done' }] })], 'checkout'))
      .toEqual({ flightId: 'fl_1', stage, stageStatus: 'done' })
  })
  it('keeps the first active match rather than searching for a later generating Flight', () => {
    const second = flight({ flightId: 'fl_2' })
    expect(coverageGeneratingFlight([flight({ currentStage: 'run' }), second], 'checkout')).toBeNull()
    expect(coverageGeneratingFlight([second, flight()], 'checkout')?.flightId).toBe('fl_2')
    expect(coverageGeneratingFlight([flight({ status: 'done' }), second], 'checkout')?.flightId).toBe('fl_2')
  })
  it('distinguishes a missing current stage from absent stage detail', () => {
    expect(coverageGeneratingFlight([flight({ currentStage: null })], 'checkout')).toBeNull()
    expect(coverageGeneratingFlight([flight()], 'checkout')).toEqual({ flightId: 'fl_1', stage: 'docs', stageStatus: 'running' })
    expect(coverageGeneratingFlight([flight({ stages: [{ key: 'scout', status: 'done' }] })], 'checkout')?.stageStatus).toBe('running')
  })
  it('presents external handoffs as running and human checkpoints as waiting', () => {
    const waiting = flight({ status: 'waiting-for-approval', checkpointKind: 'external-work',
      stages: [{ key: 'docs', status: 'waiting-for-approval' }] })
    expect(coverageGeneratingFlight([waiting], 'checkout')?.stageStatus).toBe('running')
    expect(coverageGeneratingFlight([{ ...waiting, checkpointKind: 'prd-source' }], 'checkout')?.stageStatus).toBe('waiting-for-approval')
  })
})
