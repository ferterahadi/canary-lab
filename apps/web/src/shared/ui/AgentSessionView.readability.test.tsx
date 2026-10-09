// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectAgentSessionOptions } from '@/shared/api/agent-session-socket'
import { AgentSessionView } from './AgentSessionView'
import { mountRoot } from '@/test-helpers/mount-root'

const mocks = vi.hoisted(() => ({ get: vi.fn(), connect: vi.fn((_options: ConnectAgentSessionOptions) => ({ close: vi.fn() })) }))
vi.mock('@/shared/api/flights', async (original) => ({
  ...(await original<typeof import('@/shared/api/flights')>()), getFlightAgentSession: mocks.get,
}))
vi.mock('@/shared/api/agent-session-socket', () => ({ connectAgentSessionStream: mocks.connect }))
const stamp = '2026-10-02T11:00:00+08:00'

describe('readable Activity', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => { vi.useRealTimers() })
  mountRoot({ attach: true, onMount: (mounted) => ({ container: host, root } = mounted) })
  const renderHistory = async (live = false) => act(async () => root.render(<AgentSessionView
    sessionSources={[{ source: { kind: 'flight', flightId: 'flight', stage: 'mapping', live }, label: 'Mapping coverage', startedAt: stamp }]}
    systemRows={{ pre: [`[coverage@${stamp}] Mapping started.`], post: [] }}
    externalSessions={[{ taskId: 'author:1', actionLabel: 'Writing tests', clientKind: 'codex', status: 'done', message: 'Two files applied.', startedAt: stamp, endedAt: stamp }]}
  />))

  const renderEvents = async (events: unknown[]) => {
    mocks.get.mockResolvedValue({ agent: 'codex', sessionId: 'session', events })
    await act(async () => root.render(<AgentSessionView
      sessionSources={[{ source: { kind: 'flight', flightId: 'flight', stage: 'mapping' }, label: 'Mapping coverage', startedAt: stamp }]}
    />))
  }
  const row = (verb: string) => [...host.querySelectorAll<HTMLButtonElement>('.agentts-log')]
    .find((button) => button.querySelector('.agentts-logverb')?.textContent === verb)!
  const modal = () => host.querySelector('[data-testid="activity-log-modal"]')

  it('previews the task past harness boilerplate and keeps the whole prompt in its modal', async () => {
    await renderEvents([{ kind: 'user-message', text: '<recommended_plugins>Private setup</recommended_plugins>\nWrite the tests.', timestamp: stamp }])
    const prompt = row('Instructions')
    expect(prompt.closest('li')?.getAttribute('data-kind')).toBe('prompt')
    expect(prompt.querySelector('.agentts-logkind')?.textContent).toBe('Prompt')
    expect(prompt.querySelector('.agentts-logsum')?.textContent).toBe('Write the tests.')
    expect(modal()).toBeNull()
    await act(async () => prompt.click())
    expect(modal()?.textContent).toContain('Private setup')
    expect(modal()?.textContent).toContain('Write the tests.')
    // The prompt reads as the source the agent received: numbered markdown.
    const code = host.querySelector('[data-testid="activity-log-code"]')!
    expect(code.getAttribute('data-lang')).toBe('markdown')
    expect([...code.querySelectorAll('.agentts-ln')].map((n) => n.textContent)).toEqual(['1', '2'])
    expect(host.querySelector('[data-testid="activity-log-modal"] .agentts-md')).toBeNull()
    expect(prompt.getAttribute('data-selected')).toBe('true')
  })

  it('keeps a long answer to one row and opens it whole', async () => {
    const text = 'Mapped requirement. '.repeat(30)
    await renderEvents([{ kind: 'assistant-message', text, timestamp: stamp }])
    const answer = row('Assistant')
    expect(answer.querySelector('.agentts-logsum')?.textContent?.endsWith('…')).toBe(true)
    await act(async () => answer.click())
    expect(modal()?.textContent).toContain(text.trim())
  })

  it('flags a tool failure on its row and keeps the full diagnostic in its modal', async () => {
    await renderEvents([
      { kind: 'tool-call', toolId: 'tool', name: 'Bash', input: { command: 'make', description: 'Build' }, timestamp: stamp },
      { kind: 'tool-result', toolId: 'tool', output: 'Permission denied\nfull diagnostic', isError: true, timestamp: stamp },
    ])
    const failure = row('Error')
    expect(failure.getAttribute('data-danger')).toBe('true')
    expect(failure.querySelector('.agentts-logsum')?.textContent).toBe('Permission denied')
    expect(host.textContent).not.toContain('full diagnostic')
    await act(async () => failure.click())
    expect(modal()?.textContent).toContain('full diagnostic')
    // The pair link walks from the failure to the call that produced it.
    const pair = host.querySelector<HTMLButtonElement>('[data-testid="activity-log-pair"]')!
    expect(pair.textContent).toBe('Bash ↑')
    await act(async () => pair.click())
    expect(modal()?.textContent).toContain('"command": "make"')
  })

  it('names a one-line call in the result modal instead of linking to a modal it does not have', async () => {
    await renderEvents([
      { kind: 'tool-call', toolId: 'tool', name: 'Read', input: { file_path: 'docs/tasks.md' }, timestamp: stamp },
      { kind: 'tool-result', toolId: 'tool', output: '     1\t# Tasks\n     2\tbody', timestamp: stamp },
    ])
    expect(row('Read').tagName).toBe('DIV')
    await act(async () => row('Result').click())
    const pair = host.querySelector('[data-testid="activity-log-pair"]')!
    expect(pair.tagName).toBe('SPAN')
    expect(pair.textContent).toBe('Read · docs/tasks.md')
  })

  it('marks a session that died on an API error as terminated and keeps the partial output', async () => {
    await renderEvents([{ kind: 'assistant-message', text: 'Connection failed.\nPartial output retained.', apiError: true, timestamp: stamp }])
    expect(host.querySelector('[data-testid="agent-session-mode"]')?.textContent).toBe('Terminated')
    const failure = row('API error')
    expect(failure.getAttribute('data-danger')).toBe('true')
    expect(failure.querySelector('.agentts-logsum')?.textContent).toBe('Connection failed.')
    await act(async () => failure.click())
    expect(modal()?.textContent).toContain('Partial output retained.')
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
    // With no transcript there is no session divider, so the notice is one:
    // the attempt's label on the band, and why it has no rows.
    const notice = host.querySelector('[data-testid="transcript-notice"]')!
    expect(notice.classList.contains('agentts-divrow')).toBe(true)
    expect(notice.querySelector('.agentts-divlabel')?.textContent).toBe('Mapping coverage')
    expect(notice.querySelector('.agentts-divider')?.getAttribute('data-tone')).toBe('absent')
    expect(host.textContent).toContain('Mapping started.')
    expect(host.querySelector('[data-testid="external-session-header"]')?.textContent).toContain('Writing tests')
    expect(host.querySelector('[data-testid="external-session-status"]')?.textContent).toMatch(/^Completed/)
    expect(host.querySelector('[data-testid="external-session-start"] .agentts-logverb')?.textContent).toBe('Started')
    expect(host.querySelector('[data-testid="external-session-end"] .agentts-logverb')?.textContent).toBe('Completed')
  })

  it('puts the notice under the divider as a plain line when the session itself is known', async () => {
    mocks.get.mockResolvedValue({ agent: 'codex', sessionId: 'session', events: [] })
    await renderHistory(true)
    const notice = host.querySelector('[data-testid="transcript-notice"]')!
    expect(notice.classList.contains('agentts-notice')).toBe(true)
    expect(notice.textContent).toBe('Waiting for transcript…')
    expect(host.querySelector('[data-testid="agent-session-label"]')?.textContent).toBe('Mapping coverage')
  })

  it('shows an unreadable transcript as a danger band with its read error a click away', async () => {
    mocks.get.mockRejectedValue(new Error('EACCES: permission denied'))
    await renderHistory()
    const notice = host.querySelector('[data-testid="transcript-notice"]')!
    expect(notice.querySelector('.agentts-divider')?.getAttribute('data-tone')).toBe('danger')
    expect(notice.querySelector('[role="alert"]')?.textContent).toBe('Transcript could not be read.')
    await act(async () => notice.querySelector<HTMLButtonElement>('.agentts-morebtn')!.click())
    expect(notice.textContent).toContain('EACCES: permission denied')
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
    // Each task keeps its own divider, start and end rows, even sharing a session.
    const rows = [...host.querySelectorAll('[data-activity-id]')]
    expect(new Set(rows.map((row) => row.getAttribute('data-activity-id'))).size).toBe(6)
    const headers = [...host.querySelectorAll('[data-testid="external-session-header"]')]
    expect(headers).toHaveLength(2)
    expect(headers.map((header) => header.querySelector('[data-testid="external-session-status"]')?.textContent?.split(' · ')[0]))
      .toEqual([states[status], states[status]])
    expect([...host.querySelectorAll('[data-testid="external-session-end"] .agentts-logverb')].map((verb) => verb.textContent))
      .toEqual([states[status], states[status]])
  })
})
