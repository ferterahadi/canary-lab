// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectAgentSessionOptions } from '@/shared/api/agent-session-socket'
import { AgentSessionView } from './AgentSessionView'
import { ApiErrorBody, PromptBody, ProseBody, ToolResultBody } from './AgentSessionRows'

const mocks = vi.hoisted(() => ({ get: vi.fn(), connect: vi.fn((_options: ConnectAgentSessionOptions) => ({ close: vi.fn() })) }))
vi.mock('@/shared/api/flights', async (original) => ({
  ...(await original<typeof import('@/shared/api/flights')>()), getFlightAgentSession: mocks.get,
}))
vi.mock('@/shared/api/agent-session-socket', () => ({ connectAgentSessionStream: mocks.connect }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const stamp = '2026-10-02T11:00:00+08:00'

describe('readable Activity', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.clearAllMocks()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })
  const renderHistory = async (live = false) => act(async () => root.render(<AgentSessionView
    sessionSources={[{ source: { kind: 'flight', flightId: 'flight', stage: 'mapping', live }, label: 'Mapping coverage', startedAt: stamp }]}
    systemRows={{ pre: [`[coverage@${stamp}] Mapping started.`], post: [] }}
    externalSessions={[{ taskId: 'author:1', actionLabel: 'Writing tests', clientKind: 'codex', status: 'done', message: 'Two files applied.', startedAt: stamp, endedAt: stamp }]}
  />))

  it('hides complete instructions until disclosed and keeps long answers expandable', async () => {
    const prompt = '<recommended_plugins>Private setup</recommended_plugins>\nWrite the tests.'
    await act(async () => root.render(<PromptBody text={prompt} timestamp={stamp} />))
    expect(host.textContent).not.toContain('Private setup')
    const toggle = host.querySelector('button')!
    expect(toggle.textContent).toContain('Task instructions')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain('Write the tests.')
    const text = 'Mapped requirement. '.repeat(30)
    await act(async () => root.render(<ProseBody label="Assistant" text={text} timestamp={stamp} />))
    expect(host.querySelector('.agentts-md')).toBeNull()
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => host.querySelector('button')!.click())
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain(text.trim())
  })

  it('keeps short answers and tool failure summaries visible', async () => {
    await act(async () => root.render(<><ProseBody label="Assistant" text="Mapping complete." timestamp={stamp} />
      <ToolResultBody output={'Permission denied\nfull diagnostic'} isError timestamp={stamp} toolId="tool" /></>))
    expect(host.textContent).toContain('Mapping complete.')
    expect(host.textContent).toContain('Permission denied')
    expect(host.textContent).not.toContain('full diagnostic')
    expect(host.querySelector('.agentts-errtag')?.textContent).toBe('error')
    await act(async () => host.querySelector('button')!.click())
    expect(host.textContent).toContain('full diagnostic')
  })

  it('retains the full agent failure behind its visible summary', async () => {
    await act(async () => root.render(<ApiErrorBody text={'Connection failed.\nPartial output retained.'} timestamp={stamp} />))
    expect(host.textContent).toContain('Terminated · API error')
    expect(host.textContent).toContain('Connection failed.')
    expect(host.textContent).not.toContain('Partial output retained.')
    await act(async () => host.querySelector('button')!.click())
    expect(host.textContent).toContain('Partial output retained.')
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a failed snapshot read visible alongside other activity', async () => {
    mocks.get.mockRejectedValue(new Error('Snapshot unavailable'))
    await renderHistory()
    expect(host.querySelector('[data-empty-reason]')).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Transcript could not be read.')
    const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Show read error')!
    act(() => toggle.click())
    expect(host.textContent).toContain('Snapshot unavailable')
  })

  it('shows absence inline beside system and external history without an empty illustration', async () => {
    mocks.get.mockResolvedValue({ absent: true, reason: 'no-session' })
    await renderHistory()
    expect(host.querySelector('[data-empty-reason]')).toBeNull()
    expect(host.querySelector('[data-testid="transcript-notice"]')?.textContent).toContain('No transcript recorded for this attempt.')
    expect(host.textContent).toContain('Mapping started.')
    expect(host.textContent).toContain('Writing tests · Completed')
    const start = host.querySelector('[data-testid="external-session-start"]')!
    expect(start.getAttribute('data-status')).toBe('started')
    expect(start.querySelector('[data-testid="external-session-elapsed"]')).toBeNull()
  })

  it('replaces the loading notice as the requested transcript arrives', async () => {
    let resolve!: (value: unknown) => void
    mocks.get.mockReturnValue(new Promise((done) => { resolve = done }))
    await renderHistory()
    expect(host.textContent).toContain('Loading transcript…')
    await act(async () => resolve({ agent: 'codex', sessionId: 'session', events: [{ kind: 'assistant-message', text: 'Mapped.', timestamp: stamp }] }))
    expect(host.querySelector('[data-testid="transcript-notice"]')).toBeNull()
    expect(host.textContent).toContain('Mapped.')
  })

  it('reports a missing file after bounded retries instead of claiming the task failed', async () => {
    vi.useFakeTimers()
    mocks.get.mockResolvedValue({ absent: true, reason: 'session-log-missing' })
    await renderHistory()
    await act(async () => vi.advanceTimersByTimeAsync(9500))
    expect(mocks.get).toHaveBeenCalledTimes(4)
    expect(host.textContent).toContain('Transcript file unavailable for this attempt.')
    expect(host.textContent).not.toContain('Mapping coverage · Failed')
  })

  it('surfaces read errors beside existing events and clears them after stream recovery', async () => {
    mocks.get.mockResolvedValue({ agent: 'codex', sessionId: 'session', events: [{ kind: 'assistant-message', text: 'Earlier progress.', timestamp: stamp }] })
    await renderHistory(true)
    const stream = mocks.connect.mock.calls[0][0]
    act(() => stream.onError?.('Read permission denied'))
    expect(host.textContent).toContain('Transcript could not be read.')
    const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Show read error')!
    act(() => toggle.click())
    expect(host.textContent).toContain('Read permission denied')
    act(() => {
      stream.onEvent({ kind: 'assistant-message', text: 'Earlier progress.', timestamp: stamp })
      stream.onEvent({ kind: 'assistant-message', text: 'Recovered progress.', timestamp: stamp })
    })
    expect(host.querySelector('[data-testid="transcript-notice"]')).toBeNull()
    expect(host.textContent).toContain('Recovered progress.')
  })

  it.each(['ready', 'done', 'failed', 'aborted'] as const)('distinguishes the %s outcome and tasks sharing one conversation', async (status) => {
    const states = { ready: 'Result ready', done: 'Completed', failed: 'Failed', aborted: 'Stopped' }
    await act(async () => root.render(<AgentSessionView externalSessions={['one', 'two'].map((taskId) => ({
      taskId, actionLabel: 'Writing tests', sessionId: 'shared-session', clientKind: 'codex', status,
      message: 'Recorded outcome.', startedAt: stamp, endedAt: stamp,
    }))} />))
    const rows = [...host.querySelectorAll('[data-activity-id]')]
    expect(new Set(rows.map((row) => row.getAttribute('data-activity-id'))).size).toBe(4)
    expect(host.querySelectorAll('[data-testid="external-session-activity"]')).toHaveLength(2)
    expect(host.textContent).toContain(`Writing tests · ${states[status]}`)
  })
})
