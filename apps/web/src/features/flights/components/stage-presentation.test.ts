import { describe, expect, it } from 'vitest'
import type { FlightAttention } from '@shared/flights/attention'
import { presentStageStatus } from './stage-meta'

const attention: FlightAttention = {
  state: 'actionable', stage: 'specs-coverage', title: 'Flight paused',
  reason: 'The saved coverage target is not met.', checkedAt: 'now', revision: 'a',
}
const coverageWarning = { label: 'Out of date', message: 'Tests changed; coverage out of date.' }

describe('shared stage presentation', () => {
  it('qualifies a completed mapping without changing the recorded execution status', () => {
    expect(presentStageStatus('done', 'specs-coverage', undefined, undefined, { attention, coverageWarning }))
      .toMatchObject({ status: 'done', label: 'Out of date', warning: true, title: attention.reason })
  })

  it('retains attention when mapping is fresh but the server has not verified the target', () => {
    expect(presentStageStatus('done', 'specs-coverage', undefined, undefined, { attention }))
      .toMatchObject({ label: 'Needs attention', warning: true })
  })

  it('lets authoritative resolution win over a lagging coverage snapshot', () => {
    expect(presentStageStatus('failed', 'specs-coverage', undefined, undefined, {
      attention: { ...attention, state: 'resolved', title: 'Earlier failure resolved by current evidence.' }, coverageWarning,
    })).toMatchObject({ status: 'failed', label: 'Verified', warning: false })
  })

  it.each(['scout', 'scaffold', 'docs', 'specs-coverage', 'run', 'evaluation-export', 'portify'] as const)(
    'never claims success on %s when the assessment is unavailable', (stage) => {
      expect(presentStageStatus('done', stage, undefined, undefined, {
        attention: { ...attention, stage, state: 'unavailable', reason: 'Could not verify current state' },
      })).toMatchObject({ label: 'Unverified', warning: true, title: 'Could not verify current state' })
    },
  )

  it('maps attention on a folded stage to the visible Requirements row', () => {
    expect(presentStageStatus('done', 'docs', undefined, undefined, {
      attention: { ...attention, stage: 'prd-summary' },
    })).toMatchObject({ label: 'Needs attention', warning: true })
    expect(presentStageStatus('done', 'scout', undefined, undefined, { attention }))
      .toMatchObject({ label: 'done', warning: false })
  })

  it('qualifies the earlier recovery stage and keeps live work visible', () => {
    const evidence = { coverageWarning: { ...coverageWarning, nextActionRow: 'docs' as const } }
    expect(presentStageStatus('done', 'docs', undefined, undefined, evidence))
      .toMatchObject({ label: 'Out of date', warning: true })
    expect(presentStageStatus('running', 'docs', undefined, undefined, evidence))
      .toMatchObject({ label: 'running', warning: false })
  })
})
