import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertCoverageJobAvailable, CoverageJobConflictError, createCoverageJobManifest } from './creation'

afterEach(() => vi.useRealTimers())

describe('coverage job creation', () => {
  it('preserves the conflict contract and checks the exact feature and kind', () => {
    const activeFor = vi.fn(() => ({ jobId: 'existing', feature: 'shop', kind: 'coverage' as const, status: 'running' as const, startedAt: 'then' }))
    expect(() => assertCoverageJobAvailable({ activeFor }, 'shop', 'coverage')).toThrow(CoverageJobConflictError)
    expect(() => assertCoverageJobAvailable({ activeFor }, 'shop', 'coverage')).toThrow('a coverage job is already running for shop')
    expect(activeFor).toHaveBeenCalledWith('shop', 'coverage')
    const error = new CoverageJobConflictError('shop', 'coverage', 'existing')
    expect(error).toMatchObject({ name: 'CoverageJobConflictError', statusCode: 409, feature: 'shop', kind: 'coverage', existingJobId: 'existing' })
  })

  it('allows an unoccupied slot', () => {
    expect(() => assertCoverageJobAvailable({ activeFor: () => null }, 'shop', 'summary')).not.toThrow()
  })

  it('constructs only the initial fields, consuming ID before time', () => {
    const calls: string[] = []
    const manifest = createCoverageJobManifest({ feature: 'shop', kind: 'summary', log: 'starting\n' }, {
      newJobId: function (this: void) { expect(this).toBeUndefined(); calls.push('id'); return 'fixture' },
      now: function (this: void) { expect(this).toBeUndefined(); calls.push('time'); return '2026-01-01T00:00:00.000Z' },
    })
    expect(manifest).toEqual({ jobId: 'fixture', feature: 'shop', kind: 'summary', status: 'running', startedAt: '2026-01-01T00:00:00.000Z', log: 'starting\n' })
    expect(calls).toEqual(['id', 'time'])
  })

  it('retains the default ID format and clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const manifest = createCoverageJobManifest({ feature: 'shop', kind: 'coverage', log: '' }, {})
    expect(manifest.jobId).toMatch(/^cj_[a-f0-9]{12}$/)
    expect(manifest.startedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
