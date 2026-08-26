// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StageActivity } from './StageActivity'

const mocks = vi.hoisted(() => ({
  getFlightAgentSession: vi.fn(),
  connectAgentSessionStream: vi.fn(() => ({ close: vi.fn() })),
}))

vi.mock('@/shared/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/client')>()),
  getFlightAgentSession: mocks.getFlightAgentSession,
}))

vi.mock('@/shared/api/agent-session-socket', () => ({
  connectAgentSessionStream: mocks.connectAgentSessionStream,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('StageActivity multi-session chronology', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mocks.getFlightAgentSession.mockImplementation(async (_flightId: string, stage: string) => {
      const eventText: Record<string, string> = {
        'specs-coverage-session-001': 'Pass 1 authoring event',
        'specs-coverage-session-002': 'Pass 1 mapping event',
        'specs-coverage-session-003': 'Pass 2 authoring event',
      }
      return {
        agent: 'claude',
        sessionId: stage,
        events: [{
          kind: 'assistant-message',
          timestamp: '2026-08-26T01:00:00.000Z',
          text: eventText[stage],
        }],
      }
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('keeps tagged conductor rows between sessions without replaying mirrored chunks', async () => {
    await act(async () => {
      root.render(
        <StageActivity
          sessionSources={[
            {
              label: 'Pass 1 · Authoring',
              source: { kind: 'flight', flightId: 'fl_1', stage: 'specs-coverage-session-001', live: false },
            },
            {
              label: 'Pass 1 · Mapping',
              source: { kind: 'flight', flightId: 'fl_1', stage: 'specs-coverage-session-002', live: false },
            },
            {
              label: 'Pass 2 · Authoring',
              source: { kind: 'flight', flightId: 'fl_1', stage: 'specs-coverage-session-003', live: true },
            },
          ]}
          live
          settled={false}
          log={'[specs] writing pass 1…\nmirrored author chunk\n[specs] validated 2 file(s)\n[specs] mapping pass 1…\nmirrored mapping chunk\n[specs] iteration 2: 40% / 100% — 1 gap(s)\nmirrored second author chunk\n[specs] validated 1 file(s)\n'}
          open
          onOpenChange={vi.fn()}
        />,
      )
    })

    const text = container.textContent ?? ''
    expect(text).toContain('Pass 1 authoring event')
    expect(text).toContain('validated 2 file(s)')
    expect(text).toContain('mapping pass 1…')
    expect(text).toContain('Pass 1 mapping event')
    expect(text).toContain('iteration 2: 40% / 100% — 1 gap(s)')
    expect(text).toContain('Pass 2 authoring event')
    expect(text).toContain('validated 1 file(s)')
    expect(text.indexOf('Pass 1 authoring event')).toBeLessThan(text.indexOf('validated 2 file(s)'))
    expect(text.indexOf('mapping pass 1…')).toBeLessThan(text.indexOf('Pass 1 mapping event'))
    expect(text.indexOf('Pass 1 mapping event')).toBeLessThan(text.indexOf('iteration 2: 40% / 100% — 1 gap(s)'))
    expect(text.indexOf('iteration 2: 40% / 100% — 1 gap(s)')).toBeLessThan(text.indexOf('Pass 2 authoring event'))
    expect(text.indexOf('Pass 2 authoring event')).toBeLessThan(text.indexOf('validated 1 file(s)'))
    expect(text).not.toContain('mirrored author chunk')
    expect(text).not.toContain('mirrored mapping chunk')
    expect(text).not.toContain('mirrored second author chunk')
  })
})
