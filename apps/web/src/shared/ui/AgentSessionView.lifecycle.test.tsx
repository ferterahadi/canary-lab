// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionView } from './AgentSessionView'

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
    expect(liveTail?.getAttribute('aria-label')).toBe('Agent is working')
    expect(liveTail?.querySelector('.agentts-worknode')).not.toBeNull()
    expect(liveTail?.querySelectorAll('.agentts-pixels span')).toHaveLength(3)
    expect(liveTail?.parentElement?.tagName).toBe('OL')
    expect(container.querySelector('.agentts-livefoot')).toBeNull()
    expect(mocks.connectAgentSessionStream).toHaveBeenCalledOnce()
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
