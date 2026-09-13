import { describe, expect, it } from 'vitest'
import type { FlightManifest } from './types'
import { issueCheckpointInput, allowsCheckpointInput } from './checkpoint-input'

const flight = (over: Record<string, unknown> = {}) => ({
  flightId: 'one', status: 'waiting-for-approval', updatedAt: 'v1',
  stages: [{ key: 'env-capture', status: 'waiting-for-approval', checkpoint: { kind: 'missing-env', options: ['retry', 'waive'] } }],
  ...over,
}) as unknown as FlightManifest

describe('URL-mode checkpoint invitations', () => {
  it('accepts only the exact flight and checkpoint that was invited', () => {
    const manifest = flight()
    const token = issueCheckpointInput(manifest)
    expect(allowsCheckpointInput(token, manifest)).toBe(true)
    for (const changed of [flight({ flightId: 'two' }), flight({ updatedAt: 'v2' }), flight({ status: 'paused' }), flight({ stages: [] })]) {
      expect(allowsCheckpointInput(token, changed)).toBe(false)
    }
    expect(allowsCheckpointInput(`${token.slice(0, -1)}x`, manifest)).toBe(false)
    expect(allowsCheckpointInput(`1.${token.split('.')[1]}`, manifest)).toBe(false)
    expect(allowsCheckpointInput(undefined, manifest)).toBe(false)
    expect(allowsCheckpointInput(token, null)).toBe(false)
  })
  it('never invites the user to submit agent work', () => {
    const manifest = flight({ stages: [{ key: 'scout', status: 'waiting-for-approval', checkpoint: { kind: 'external-work' } }] })
    expect(allowsCheckpointInput(issueCheckpointInput(manifest), manifest)).toBe(false)
  })
})
