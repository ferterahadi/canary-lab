import { expect, it } from 'vitest'
import type { FlightManifest } from '@shared/flights/types'
import { parseSystemLine, systemLogId } from '@/shared/ui/activity-log'
import { attentionFailureHistory } from './attention-history'

const flight = {
  status: 'paused', pauseReason: 'stage-failed', updatedAt: '2026-01-01T00:02:00Z',
  attention: { state: 'resolved', stage: 'prd-summary' },
  stages: [{ key: 'prd-summary', status: 'failed', endedAt: '2026-01-01T00:01:00Z', error: 'Launch failed\nFull usage output' }],
} as FlightManifest

it('retains the original error and date in a routed entry for a folded stage after resolution', () => {
  const history = attentionFailureHistory(flight, 'docs', 'prd-summary')!
  expect(parseSystemLine(history.line)).toEqual({ tag: 'failure', timestamp: '2026-01-01T00:01:00Z',
    text: 'Earlier failure\nLaunch failed\nFull usage output' })
  expect(history.id).toBe(systemLogId(history.line))
  expect(attentionFailureHistory(flight, 'specs-coverage')).toBeUndefined()
})

it('uses a legacy flight error without inventing a transcript and omits absent history', () => {
  const legacy = { ...flight, stages: [], error: 'Legacy launch failed' }
  expect(parseSystemLine(attentionFailureHistory(legacy, 'prd-summary')!.line).timestamp).toBe(legacy.updatedAt)
  expect(attentionFailureHistory({ ...legacy, error: undefined }, 'prd-summary')).toBeUndefined()
})
