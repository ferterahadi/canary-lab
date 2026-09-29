import { describe, expect, it } from 'vitest'
import { presentRunStatus } from './run-presentation'

describe('presentRunStatus', () => {
  it.each([
    ['queued', 'Queued', 'var(--text-secondary)', 'idle', false],
    ['running', 'Running', 'var(--running)', 'running', true],
    ['healing', 'Healing', 'var(--warning)', 'warning', true],
    ['passed', 'Passed', 'var(--success)', 'success', false],
    ['failed', 'Failed', 'var(--danger)', 'failed', false],
    ['aborted', 'Aborted', 'var(--text-muted)', 'idle', false],
    ['aborting', 'Aborting', 'var(--warning)', 'warning', true],
    ['deleting', 'Deleting', 'var(--danger)', 'failed', true],
    ['cancelling-heal', 'Cancelling', 'var(--warning)', 'warning', true],
    ['pausing', 'Pausing', 'var(--warning)', 'warning', true],
  ] as const)('%s has one label and color contract', (status, label, tone, dot, pulse) => {
    expect(presentRunStatus({ status })).toMatchObject({ label, tone, dot, pulse })
  })

  it('qualifies a healing run that waits for review or an agent', () => {
    for (const waiting of [
      { kind: 'test-review' as const, label: 'Awaiting test review', detail: 'Review edits.' },
      { kind: 'agent' as const, label: 'Awaiting Agent', detail: 'Resume agent.' },
    ]) {
      expect(presentRunStatus({ status: 'healing', waiting })).toMatchObject({
        label: waiting.label, tone: 'var(--warning)', dot: 'warning', pulse: false,
      })
    }
  })

  it('presents queued and boot sessions without implying tests are executing', () => {
    expect(presentRunStatus({ status: 'queued', waiting: {
      kind: 'queued', label: 'Queued', detail: 'Waiting for resources.',
    } })).toMatchObject({ label: 'Queued', tone: 'var(--text-muted)', pulse: false })
    expect(presentRunStatus({ status: 'running', executionType: 'boot' })).toMatchObject({ label: 'Services up', tone: 'var(--boot)', dot: 'booted' })
    expect(presentRunStatus({ status: 'aborted', executionType: 'boot' })).toMatchObject({ label: 'Stopped', tone: 'var(--text-muted)' })
  })
})
