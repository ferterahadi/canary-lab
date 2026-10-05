import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { RecoveryTimeline } from './RunDiagnosticsPanels'
import { formatLocalDateTime } from '@/shared/lib/format'
import type { TimelineRow } from '../utils/run-timeline'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('updates local timestamp tooltips without replacing the timeline row', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const row: TimelineRow = {
    key: 'event-1', ts: '2026-10-05T06:02:30Z', severity: 'info', headline: 'Preparing services',
    detail: null, durationLabel: null, clientLabel: null, source: 'engine', event: null, isLastEngine: false,
  }
  try {
    act(() => root.render(<RecoveryTimeline rows={[row]} />))
    const time = container.querySelector('time')!
    expect(time.title).toBe(formatLocalDateTime(row.ts))
    act(() => root.render(<RecoveryTimeline rows={[{ ...row, ts: '2026-10-05T06:03:30Z' }]} />))
    expect(container.querySelector('time')).toBe(time)
    expect(time.title).toBe(formatLocalDateTime('2026-10-05T06:03:30Z'))
    act(() => root.render(<RecoveryTimeline rows={[{ ...row, ts: 'invalid' }]} />))
    expect(time.title).toBe('invalid')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
