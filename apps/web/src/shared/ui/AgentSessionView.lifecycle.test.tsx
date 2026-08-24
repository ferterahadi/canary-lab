// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionView, pendingWork } from './AgentSessionView'

const mocks = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
  getFlightAgentSession: vi.fn(),
  connectAgentSessionStream: vi.fn(() => ({ close: vi.fn() })),
}))

vi.mock('@/shared/api/client', async (importOriginal) => ({
  // Keep the real `isAgentSessionAbsence` — the view discriminates fetch
  // results with it, and a stubbed guard would decouple these tests from the
  // actual absence contract.
  ...(await importOriginal<typeof import('@/shared/api/client')>()),
  getAgentSession: mocks.getAgentSession,
  getFlightAgentSession: mocks.getFlightAgentSession,
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

  it('treats a live-mode absence like an empty snapshot and still opens the tail', async () => {
    // Live mode never blocks on the absence — the WS handles "not on disk yet"
    // server-side, so the pane waits with the stream open instead of erroring.
    mocks.getAgentSession.mockResolvedValueOnce({ absent: true, reason: 'session-log-missing' })
    await render(true)

    expect(container.textContent).toContain("Waiting for the agent's first output")
    expect(mocks.connectAgentSessionStream).toHaveBeenCalledOnce()
  })

  describe('history snapshot retry', () => {
    // A run whose status has just gone terminal can beat the agent CLI's final
    // flush of the session log to disk. History mode has no WS to tail, so that
    // one read was the pane's only chance — and a null there froze it on "no
    // transcript" for good while the file appeared moments later.
    const settled = {
      agent: 'claude' as const,
      sessionId: 'session-late',
      events: [{ kind: 'assistant-message' as const, timestamp: '2026-08-05T08:00:00.000Z', text: 'Landed late' }],
    }

    it('retries a null history snapshot until the log lands', async () => {
      vi.useFakeTimers()
      mocks.getAgentSession.mockReset()
      mocks.getAgentSession.mockResolvedValueOnce(null).mockResolvedValue(settled)

      await act(async () => {
        root.render(<AgentSessionView source={{ kind: 'run', runId: 'run-1', live: false }} />)
      })
      // Fires the first back-off step, then lets the refetch's promise settle.
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })

      expect(mocks.getAgentSession).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Landed late')
      vi.useRealTimers()
    })

    it('does not retry when the first history read already has events', async () => {
      // Negative control: without this the retry could be unconditional and the
      // test above would still pass, at the cost of a duplicate fetch on every
      // settled run anyone opens.
      await render(false)

      expect(mocks.getAgentSession).toHaveBeenCalledTimes(1)
    })

    it('shows the empty state immediately on a definitive absence — no retries', async () => {
      // The server said "nothing was ever recorded" (`no-session`); burning the
      // full ~9.5s back-off on it held every agentless stage open on "Loading
      // session…" — the shipped demo's derived flights hit this on every open.
      vi.useFakeTimers()
      mocks.getFlightAgentSession.mockResolvedValue({ absent: true, reason: 'no-session' })

      await act(async () => {
        root.render(<AgentSessionView source={{ kind: 'flight', flightId: 'fl_1', stage: 'coverage-1', live: false }} />)
      })

      expect(mocks.getFlightAgentSession).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('No agent session was recorded')
      vi.useRealTimers()
    })

    it('still retries a transient absence (session-log-missing) until the log lands', async () => {
      // A ref exists but the CLI's file hasn't hit disk yet — the exact race
      // the retry was built for, now expressed as a reasoned absence.
      vi.useFakeTimers()
      mocks.getAgentSession.mockReset()
      mocks.getAgentSession
        .mockResolvedValueOnce({ absent: true, reason: 'session-log-missing' })
        .mockResolvedValue(settled)

      await act(async () => {
        root.render(<AgentSessionView source={{ kind: 'run', runId: 'run-1', live: false }} />)
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })

      expect(mocks.getAgentSession).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Landed late')
      vi.useRealTimers()
    })

    it("retries a run's no-session-ref — the ref file trails the terminal status", async () => {
      vi.useFakeTimers()
      mocks.getAgentSession.mockReset()
      mocks.getAgentSession
        .mockResolvedValueOnce({ absent: true, reason: 'no-session-ref' })
        .mockResolvedValue(settled)

      await act(async () => {
        root.render(<AgentSessionView source={{ kind: 'run', runId: 'run-1', live: false }} />)
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })

      expect(mocks.getAgentSession).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Landed late')
      vi.useRealTimers()
    })

    it("treats a run's run-not-found as definitive — kind alone doesn't grant a retry", async () => {
      // Negative control for the run-scoped exception: only `no-session-ref`
      // can lag on a run; an unknown run id can't resolve by waiting.
      vi.useFakeTimers()
      mocks.getAgentSession.mockReset()
      mocks.getAgentSession.mockResolvedValue({ absent: true, reason: 'run-not-found' })

      await act(async () => {
        root.render(<AgentSessionView source={{ kind: 'run', runId: 'run-gone', live: false }} />)
      })

      expect(mocks.getAgentSession).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('No agent session was recorded')
      vi.useRealTimers()
    })

    it('gives up after the bounded back-off rather than spinning forever', async () => {
      // The `pollUntilFound` mode this replaces waited indefinitely and turned a
      // genuinely absent log into a permanent spinner.
      vi.useFakeTimers()
      mocks.getAgentSession.mockReset()
      mocks.getAgentSession.mockResolvedValue(null)

      await act(async () => {
        root.render(<AgentSessionView source={{ kind: 'run', runId: 'run-1', live: false }} />)
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

      // One initial read plus one per back-off step, and no more.
      expect(mocks.getAgentSession).toHaveBeenCalledTimes(4)
      vi.useRealTimers()
    })
  })
})
