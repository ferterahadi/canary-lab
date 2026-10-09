import type { AgentSessionEvent } from '@shared/agent-session-types'
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectAgentSessionOptions } from '@/shared/api/agent-session-socket'

import { AgentSessionView } from './AgentSessionView'
import { mountRoot } from '@/test-helpers/mount-root'

const mocks = vi.hoisted(() => ({ get: vi.fn(), connect: vi.fn((_options: ConnectAgentSessionOptions) => ({ close: vi.fn() })) }))
vi.mock('@/shared/api/flights', async (original) => ({
  ...(await original<typeof import('@/shared/api/flights')>()), getFlightAgentSession: mocks.get,
}))
vi.mock('@/shared/api/agent-session-socket', () => ({ connectAgentSessionStream: mocks.connect }))
const event = (text: string, timestamp: string): AgentSessionEvent => ({ kind: 'assistant-message', text, timestamp })

describe('interleaved Activity', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.clearAllMocks()
  })
  mountRoot({ attach: true, onMount: (mounted) => ({ container: host, root } = mounted) })
  const texts = () => [...host.querySelectorAll('[data-activity-id]')].map((node) => node.textContent).join('\n')

  it('merges overlapping sessions, individual system messages, and external lifecycles by timestamp', async () => {
    mocks.get.mockImplementation(async (_id: string, stage: string) => ({
      agent: 'claude', model: 'claude-opus', sessionId: stage,
      events: stage === 'first' ? [event('Late first answer', '2026-10-02T12:05:09+08:00')]
        : [event('Second prompt', '2026-10-02T11:59:03+08:00')],
    }))
    await act(async () => root.render(<AgentSessionView
      sessionSources={[
        { source: { kind: 'flight', flightId: 'flight', stage: 'first' }, label: 'First', startedAt: '2026-10-02T11:57:31+08:00' },
        { source: { kind: 'flight', flightId: 'flight', stage: 'second' }, label: 'Second', startedAt: '2026-10-02T11:59:00+08:00' },
      ]}
      systemRows={{ pre: ['[coverage@2026-10-02T11:58:30+08:00] Aborted', '[coverage@2026-10-02T11:58:31+08:00] Restarting'], post: [] }}
      externalSessions={[{ clientKind: 'codex', status: 'done', message: 'External finished', startedAt: '2026-10-01T18:16:07+08:00', endedAt: '2026-10-01T18:17:30+08:00' }]}
    />))
    const text = texts()
    expect(text.indexOf('External finished')).toBeLessThan(text.indexOf('Aborted'))
    expect(text.indexOf('Aborted')).toBeLessThan(text.indexOf('Restarting'))
    expect(text.indexOf('Restarting')).toBeLessThan(text.indexOf('Second prompt'))
    expect(text.indexOf('Second prompt')).toBeLessThan(text.indexOf('Late first answer'))
    // Two conductor lines and the external session's start and end, each one
    // System row carrying its own time.
    expect(host.querySelectorAll('.agentts-row[data-kind="system"] .agentts-time')).toHaveLength(4)
    expect(host.querySelectorAll('[data-testid="external-session-header"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-testid="activity-date"]')).toHaveLength(2)
    expect(host.querySelectorAll('[data-testid="external-session-start"]')).toHaveLength(1)
  })

  it('inserts late live events without remounting a selected row or closing its log, and deduplicates reconnect replay', async () => {
    const prompt = event('Long prompt '.repeat(100), '2026-10-02T12:05:09+08:00')
    mocks.get.mockResolvedValue({ agent: 'codex', sessionId: 'live', events: [prompt] })
    await act(async () => root.render(<AgentSessionView source={{ kind: 'flight', flightId: 'flight', stage: 'live', live: true }} />))
    const stream = mocks.connect.mock.calls[0][0] as unknown as ConnectAgentSessionOptions
    const agentRows = () => host.querySelectorAll('li[data-kind="agent"]')
    const oldRow = agentRows()[0]
    act(() => oldRow.querySelector('button')!.click())
    expect(document.querySelector('[data-testid="activity-log-modal"]')).not.toBeNull()
    const scroller = host.querySelector<HTMLElement>('.overflow-y-auto')!
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    scroller.scrollTop = 400
    vi.spyOn(oldRow, 'getBoundingClientRect').mockImplementation(() => {
      const index = [...agentRows()].indexOf(oldRow)
      return new DOMRect(0, 500 + index * 80 - scroller.scrollTop, 300, 100)
    })
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })))
    const late = event('Earlier arriving late', '2026-10-02T11:58:30+08:00')
    act(() => {
      stream.onSession?.({ agent: 'codex', sessionId: 'live' })
      stream.onEvent(prompt)
      stream.onEvent(late)
    })
    expect(texts().indexOf('Earlier arriving late')).toBeLessThan(texts().indexOf('Long prompt'))
    expect(agentRows()[1]).toBe(oldRow)
    expect(oldRow.querySelector('button')?.getAttribute('data-selected')).toBe('true')
    expect(document.querySelector('[data-testid="activity-log-modal"]')?.textContent).toContain('Long prompt')
    expect(scroller.scrollTop).toBe(480)
    expect(host.querySelector('[aria-label="Jump to latest"]')).not.toBeNull()
    act(() => {
      stream.onSession?.({ agent: 'codex', sessionId: 'live' })
      stream.onEvent(prompt)
      stream.onEvent(late)
      stream.onEvent(event('Newest', '2026-10-02T12:06:00+08:00'))
    })
    expect(agentRows()).toHaveLength(3)
    expect(texts().indexOf('Newest')).toBeGreaterThan(texts().indexOf('Long prompt'))
  })
})
