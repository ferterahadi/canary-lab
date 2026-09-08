import { expect, it } from 'vitest'
import { featureChipState } from './FlightChipState'
import { runWaitingState } from '@/features/runs'

it('keeps queued flight chips neutral and non-pulsing', () => {
  const waiting = runWaitingState({ runId: 'q', feature: 'merchant', status: 'queued', startedAt: '' })
  expect(featureChipState(null, { kind: 'running', runId: 'q', waiting })).toMatchObject({ label: 'queued', live: false, tone: 'var(--text-muted)' })
})

