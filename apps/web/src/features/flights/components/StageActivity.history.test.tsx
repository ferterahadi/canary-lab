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

  it('keeps timestamped conductor rows between sessions without a copied transcript', async () => {
    await act(async () => {
      root.render(
        <StageActivity
          sessionSources={[
            {
              label: 'Pass 1 · Authoring',
              startedAt: '2026-08-26T01:00:00.000Z',
              source: { kind: 'flight', flightId: 'fl_1', stage: 'specs-coverage-session-001', live: false },
            },
            {
              label: 'Pass 1 · Mapping',
              startedAt: '2026-08-26T01:04:00.000Z',
              source: { kind: 'flight', flightId: 'fl_1', stage: 'specs-coverage-session-002', live: false },
            },
            {
              label: 'Pass 2 · Authoring',
              startedAt: '2026-08-26T01:08:00.000Z',
              source: { kind: 'flight', flightId: 'fl_1', stage: 'specs-coverage-session-003', live: true },
            },
          ]}
          live
          settled={false}
          log={'[specs@2026-08-26T00:59:00.000Z] writing pass 1…\n[specs@2026-08-26T01:02:00.000Z] validated 2 file(s)\n[specs@2026-08-26T01:03:00.000Z] mapping pass 1…\n[specs@2026-08-26T01:06:00.000Z] iteration 2: 40% / 100% — 1 gap(s)\n[specs@2026-08-26T01:09:00.000Z] validated 1 file(s)\n'}
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
  })

  it('keeps old raw-chunk separators readable without rendering them', async () => {
    await act(async () => {
      root.render(
        <StageActivity
          sessionSources={[
            {
              label: 'Pass 1 · Authoring',
              source: { kind: 'flight', flightId: 'fl_legacy', stage: 'specs-coverage-session-001', live: false },
            },
            {
              label: 'Pass 1 · Mapping',
              source: { kind: 'flight', flightId: 'fl_legacy', stage: 'specs-coverage-session-002', live: false },
            },
          ]}
          live={false}
          settled
          log={'[specs] writing pass 1…\nlegacy author chunk\n[specs] validated 2 file(s)\nlegacy mapping chunk\n[specs] mapped 4 requirement(s)\n'}
          open
          onOpenChange={vi.fn()}
        />,
      )
    })

    const text = container.textContent ?? ''
    expect(text.indexOf('Pass 1 authoring event')).toBeLessThan(text.indexOf('validated 2 file(s)'))
    expect(text.indexOf('validated 2 file(s)')).toBeLessThan(text.indexOf('Pass 1 mapping event'))
    expect(text.indexOf('Pass 1 mapping event')).toBeLessThan(text.indexOf('mapped 4 requirement(s)'))
    expect(text).not.toContain('legacy author chunk')
    expect(text).not.toContain('legacy mapping chunk')
  })
})
