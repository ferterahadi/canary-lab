// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionView, pendingWork } from './AgentSessionView'

const mocks = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
  connectAgentSessionStream: vi.fn(() => ({ close: vi.fn() })),
}))

vi.mock('@/shared/api/client', () => ({
  getAgentSession: mocks.getAgentSession,
}))

vi.mock('@/shared/api/agent-session-socket', () => ({
  connectAgentSessionStream: mocks.connectAgentSessionStream,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentSessionView lifecycle presentation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mocks.getAgentSession.mockResolvedValue({
      agent: 'claude',
      sessionId: 'session-123456789',
      model: 'claude-opus',
      events: [{ kind: 'assistant-message', timestamp: '2026-08-05T08:00:00.000Z', text: 'Working' }],
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const render = async (live: boolean): Promise<void> => {
    await act(async () => {
      root.render(<AgentSessionView source={{ kind: 'run', runId: 'run-1', live }} />)
    })
  }

  it('labels a running session as live and ends the timeline with a working row', async () => {
    await render(true)

    expect(container.querySelector('[data-testid="agent-session-mode"]')?.textContent).toBe('Live')
    const liveTail = container.querySelector('[data-testid="agent-session-live-tail"]')
    expect(liveTail?.querySelector('.agentts-worklabel')?.textContent).toBe('Working')
    expect(liveTail?.getAttribute('aria-label')).toBe('Working')
    expect(liveTail?.querySelector('.agentts-worknode')).not.toBeNull()
    expect(liveTail?.querySelectorAll('.agentts-pixels span')).toHaveLength(3)
    expect(liveTail?.parentElement?.tagName).toBe('OL')
    expect(container.querySelector('.agentts-livefoot')).toBeNull()
    expect(mocks.connectAgentSessionStream).toHaveBeenCalledOnce()
  })

  it('names the tool still in flight and clocks how long it has been waiting', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T08:00:12.000Z'))
    mocks.getAgentSession.mockResolvedValue({
      agent: 'claude',
      sessionId: 'session-123456789',
      events: [
        { kind: 'tool-call', timestamp: '2026-08-05T07:59:00.000Z', toolId: 't1', name: 'Read', input: {} },
        { kind: 'tool-result', timestamp: '2026-08-05T07:59:02.000Z', toolId: 't1', output: 'ok' },
        { kind: 'tool-call', timestamp: '2026-08-05T08:00:00.000Z', toolId: 't2', name: 'Bash', input: {} },
      ],
    })
    await render(true)

    const liveTail = container.querySelector('[data-testid="agent-session-live-tail"]')
    expect(liveTail?.querySelector('.agentts-worklabel')?.textContent).toBe('Running Bash')
    expect(container.querySelector('[data-testid="agent-session-live-elapsed"]')?.textContent).toBe('12s')
    expect(liveTail?.getAttribute('aria-label')).toBe('Running Bash, 12s elapsed')

    // The clock is the liveness signal that survives reduced motion, so it has
    // to keep advancing on its own — not only when a new event arrives.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(container.querySelector('[data-testid="agent-session-live-elapsed"]')?.textContent).toBe('15s')
    vi.useRealTimers()
  })

  it('omits the clock when the transcript timestamp disagrees with the browser', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T08:00:00.000Z'))
    mocks.getAgentSession.mockResolvedValue({
      agent: 'claude',
      sessionId: 'session-123456789',
      // Stamped in the future (clock skew) and far in the past (>24h) — neither
      // yields a figure worth showing.
      events: [{ kind: 'assistant-message', timestamp: '2026-08-05T09:00:00.000Z', text: 'hi' }],
    })
    await render(true)

    const liveTail = container.querySelector('[data-testid="agent-session-live-tail"]')
    expect(liveTail?.querySelector('.agentts-worklabel')?.textContent).toBe('Working')
    expect(container.querySelector('[data-testid="agent-session-live-elapsed"]')).toBeNull()
    expect(liveTail?.getAttribute('aria-label')).toBe('Working')
    vi.useRealTimers()
  })

  it('drops an unparseable timestamp rather than rendering NaN', async () => {
    mocks.getAgentSession.mockResolvedValue({
      agent: 'claude',
      sessionId: 'session-123456789',
      events: [{ kind: 'assistant-message', timestamp: 'not-a-date', text: 'hi' }],
    })
    await render(true)

    expect(container.querySelector('[data-testid="agent-session-live-elapsed"]')).toBeNull()
  })

  it('drops a clock older than a day — a stale tail is not a 30-hour wait', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T14:00:00.000Z'))
    mocks.getAgentSession.mockResolvedValue({
      agent: 'claude',
      sessionId: 'session-123456789',
      events: [{ kind: 'assistant-message', timestamp: '2026-08-05T08:00:00.000Z', text: 'hi' }],
    })
    await render(true)

    expect(container.querySelector('[data-testid="agent-session-live-elapsed"]')).toBeNull()
    vi.useRealTimers()
  })

  it('falls back to a neutral label when the rail has a session but no events yet', () => {
    // Reachable live: the session id lands before the first event does.
    expect(pendingWork([])).toEqual({ label: 'Working' })
  })

  it('stays neutral once a tool call has settled — the next phase is unknown', () => {
    expect(pendingWork([
      { kind: 'tool-call', timestamp: '2026-08-05T08:00:00.000Z', toolId: 't1', name: 'Read', input: {} },
      { kind: 'tool-result', timestamp: '2026-08-05T08:00:01.000Z', toolId: 't1', output: 'ok' },
    ])).toEqual({ label: 'Working', since: '2026-08-05T08:00:01.000Z' })
  })

  it('labels a settled session as history without showing live loading motion', async () => {
    await render(false)

    expect(container.querySelector('[data-testid="agent-session-mode"]')?.textContent).toBe('History')
    expect(container.querySelector('[data-testid="agent-session-live-tail"]')).toBeNull()
    expect(mocks.connectAgentSessionStream).not.toHaveBeenCalled()
  })

  it('keeps the live footer visible while the session is waiting for its first event', async () => {
    mocks.getAgentSession.mockResolvedValueOnce(null)
    await render(true)

    expect(container.textContent).toContain("Waiting for the agent's first output")
    expect(container.querySelector('[data-testid="agent-session-live-tail"]')).not.toBeNull()
  })
})
