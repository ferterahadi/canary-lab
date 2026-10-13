import type { AgentSessionEvent } from '@shared/agent-session-types'
// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentSessionView, indexSubagents, mergeSubagentEvent } from './AgentSessionView'
import { Markdown } from './AgentSessionRows'

const mocks = vi.hoisted(() => ({ get: vi.fn(), connect: vi.fn(() => ({ close: vi.fn() })) }))
vi.mock('@/shared/api/flights', async (original) => ({
  ...(await original<typeof import('@/shared/api/flights')>()), getFlightAgentSession: mocks.get,
}))
vi.mock('@/shared/api/agent-session-socket', () => ({ connectAgentSessionStream: mocks.connect }))

describe('Markdown (agent session prose)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = async (text: string): Promise<void> => {
    // Markdown loads its parser lazily now — poll the fallback away, because a
    // real module load takes macrotasks, not one microtask flush.
    await act(async () => root.render(<Markdown text={text} />))
    for (let i = 0; i < 50 && container.querySelector('.agentts-mdfallback'); i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
    }
  }

  it('renders GFM tables as a real <table>', async () => {
    await render('| Construct | Action |\n| --- | --- |\n| listener | portified |')
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelector('td')?.textContent).toBe('listener')
  })

  it('renders headings, bold, and inline code as elements (not raw syntax)', async () => {
    await render('## Findings\n\nThe **only** listener uses `process.env.PORT`.')
    expect(container.querySelector('h2')?.textContent).toBe('Findings')
    expect(container.querySelector('strong')?.textContent).toBe('only')
    expect(container.querySelector('code')?.textContent).toBe('process.env.PORT')
    // No literal markdown tokens leak into the rendered text.
    expect(container.textContent).not.toContain('##')
    expect(container.textContent).not.toContain('**')
  })

  it('does not render raw HTML embedded in the markdown', async () => {
    await render('Hello <img src=x onerror="alert(1)"> world')
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('System rows (flight conductor lines on the agent rail)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (...lines: string[]): void => {
    act(() => root.render(<AgentSessionView systemRows={{ pre: lines, post: [] }} />))
  }
  const rows = () => [...container.querySelectorAll('[data-testid="system-row"]')]
  const part = (row: Element, name: string) => row.querySelector(`.agentts-log${name}`)?.textContent

  it('reads a tagged line as one System row: the tag is the verb, the message the summary', () => {
    render('[boot-verify] all services ready')
    const [row] = rows()
    expect(row.getAttribute('data-kind')).toBe('system')
    expect(part(row, 'kind')).toBe('System')
    expect(part(row, 'verb')).toBe('Boot-verify')
    expect(part(row, 'sum')).toBe('all services ready')
  })

  it('stamps a dated line with its own time and keeps the message clean', () => {
    render('[docs@2026-07-22T20:35:24.000Z] collecting repo docs…')
    // The rendered clock is local-time, so assert the source instant instead.
    expect(rows()[0].querySelector('.agentts-time')?.getAttribute('title')).toBe('2026-07-22T20:35:24.000Z')
    expect(part(rows()[0], 'sum')).toBe('collecting repo docs…')
  })

  it('reads an undated or untagged line without inventing a time or a tag', () => {
    render('[docs] collecting repo docs…', 'plain conductor note')
    expect(rows().map((row) => part(row, 'verb'))).toEqual(['Docs', 'System'])
    expect(part(rows()[1], 'sum')).toBe('plain conductor note')
    expect(container.querySelector('.agentts-time[title]')).toBeNull()
  })

  it('gives every line its own row, repeats included, so each keeps its place in time', () => {
    render('[docs] no meaningful diff vs base', '[docs] no meaningful diff vs base', '[run] b')
    expect(rows()).toHaveLength(3)
  })

  it('shows a conductor line whole, as plain text with nothing to open', () => {
    render('[docs] collecting repo docs…')
    const row = rows()[0]
    expect(row.querySelector('button')).toBeNull()
    expect(row.querySelector('.agentts-log')?.getAttribute('data-whole')).toBe('true')
    expect(row.querySelector('.agentts-chev')).toBeNull()
  })

  it('keeps a dated multiline failure in one Activity entry without an agent transcript', () => {
    const error = "agent exited with code 2\nUsage: codex exec [OPTIONS]\nMore diagnostic detail"
    render(`[failure@2026-01-01T00:01:00Z] Earlier failure\n${error}`)
    expect(rows()).toHaveLength(1)
    expect(part(rows()[0], 'sum')).toBe('Earlier failure')
    expect(rows()[0].querySelector('.agentts-time')?.getAttribute('title')).toBe('2026-01-01T00:01:00Z')
    expect(container.textContent).not.toContain('Usage:')
    act(() => rows()[0].querySelector('button')!.click())
    const modal = document.querySelector('[data-testid="activity-log-modal"]')!
    for (const line of error.split('\n')) expect(modal.textContent).toContain(line)
    act(() => (document.querySelector('[aria-label="Close"]') as HTMLButtonElement).click())
  })

  it('opens a historical system entry directly from its routed ID without a transcript', async () => {
    const { systemLogId } = await import('./activity-log')
    const line = '[failure@2026-01-01T00:01:00Z] Earlier failure\nLaunch failed before a session existed'
    const close = vi.fn()
    act(() => root.render(<AgentSessionView systemRows={{ pre: [line], post: [] }}
      openLogId={systemLogId(line)} onOpenLogChange={close} />))
    expect(document.querySelector('[data-testid="activity-log-modal"]')?.textContent).toContain('Launch failed before a session existed')
    act(() => (document.querySelector('[aria-label="Close"]') as HTMLButtonElement).click())
    expect(close).toHaveBeenCalledWith(null)
  })

  it('cuts a line too long for its row to one line, and opens it pretty-printed', () => {
    const raw = JSON.stringify({ type: 'system', subtype: 'hook_response', output: 'x'.repeat(300) })
    render(`[evaluation] ${raw}`)
    const row = rows()[0]
    expect(part(row, 'sum')).toHaveLength(160)
    act(() => row.querySelector('button')!.click())
    const modal = document.querySelector('[data-testid="activity-log-modal"]')!
    expect(modal.textContent).toContain('Evaluation')
    expect(modal.querySelector('[data-lang="json"]')?.textContent).toContain('"subtype": "hook_response"')
    act(() => (document.querySelector('[aria-label="Close"]') as HTMLButtonElement).click())
  })

  it('opens a long line that is not JSON as plain text', () => {
    render(`plain ${'y'.repeat(200)}`)
    act(() => rows()[0].querySelector('button')!.click())
    const modal = document.querySelector('[data-testid="activity-log-modal"]')!
    expect(modal.querySelector('[data-lang="json"]')).toBeNull()
    expect(modal.textContent).toContain('y'.repeat(200))
    act(() => (document.querySelector('[aria-label="Close"]') as HTMLButtonElement).click())
  })
})

// ─── Subagent threads ───────────────────────────────────────────────────────

const child = (id: string, parentToolId: string, events: AgentSessionEvent[] = []) => ({
  agentId: id, parentToolId, agentType: 'Explore', description: 'find things', spawnDepth: 1,
  logPath: `/logs/${id}.jsonl`, events,
})
const text = (ts: string, t: string, apiError?: boolean): AgentSessionEvent =>
  ({ kind: 'assistant-message', timestamp: ts, text: t, ...(apiError ? { apiError: true } : {}) })

describe('mergeSubagentEvent', () => {
  const identity = { ...child('agent-a', 'toolu_1') } as Omit<ReturnType<typeof child>, 'events'>

  it('files an event under its parent tool id', () => {
    const map = mergeSubagentEvent(new Map(), { thread: identity, event: text('t0', 'one'), index: 0 })
    expect(map.get('toolu_1')).toHaveLength(1)
    expect(map.get('toolu_1')![0].events[0]).toMatchObject({ text: 'one' })
  })

  it('is idempotent on a replayed index — the same event twice lands once', () => {
    let map = mergeSubagentEvent(new Map(), { thread: identity, event: text('t0', 'one'), index: 0 })
    map = mergeSubagentEvent(map, { thread: identity, event: text('t0', 'one'), index: 0 })
    expect(map.get('toolu_1')![0].events.filter(Boolean)).toHaveLength(1)
  })

  it('places out-of-order arrivals at their own index, not append order', () => {
    let map = mergeSubagentEvent(new Map(), { thread: identity, event: text('t2', 'third'), index: 2 })
    map = mergeSubagentEvent(map, { thread: identity, event: text('t0', 'first'), index: 0 })
    const events = map.get('toolu_1')![0].events
    expect(events[0]).toMatchObject({ text: 'first' })
    expect(events[2]).toMatchObject({ text: 'third' })
  })

  it('keeps sibling threads spawned by the same tool call separate', () => {
    const other = { ...child('agent-b', 'toolu_1') } as typeof identity
    let map = mergeSubagentEvent(new Map(), { thread: identity, event: text('t0', 'a'), index: 0 })
    map = mergeSubagentEvent(map, { thread: other, event: text('t0', 'b'), index: 0 })
    expect(map.get('toolu_1')!.map((t) => t.agentId)).toEqual(['agent-a', 'agent-b'])
  })

  it('does not mutate the previous map (React state identity)', () => {
    const before = mergeSubagentEvent(new Map(), { thread: identity, event: text('t0', 'one'), index: 0 })
    const after = mergeSubagentEvent(before, { thread: identity, event: text('t1', 'two'), index: 1 })
    expect(before.get('toolu_1')![0].events.filter(Boolean)).toHaveLength(1)
    expect(after).not.toBe(before)
  })
})

describe('indexSubagents', () => {
  it('groups a snapshot list by parent tool id', () => {
    const map = indexSubagents([child('a', 'toolu_1'), child('b', 'toolu_2'), child('c', 'toolu_1')])
    expect(map.get('toolu_1')!.map((t) => t.agentId)).toEqual(['a', 'c'])
    expect(map.get('toolu_2')).toHaveLength(1)
  })

  it('tolerates a server that sends no subagents field', () => {
    expect(indexSubagents(undefined).size).toBe(0)
  })
})

describe('Activity log routing (controlled by the URL)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mocks.get.mockResolvedValue({ agent: 'claude', sessionId: 'session', events: [
      text('2026-07-21T11:31:00.000Z', 'First finding.\nWith detail.'),
      text('2026-07-21T11:32:00.000Z', 'Second finding.\nWith detail.'),
      text('2026-07-21T11:33:00.000Z', 'Done.'),
    ] })
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const id = (index: number) => `flight:flight:docs:event:${index}`
  const render = async (openLogId: string | null, onOpenLogChange = vi.fn()): Promise<typeof onOpenLogChange> => {
    await act(async () => root.render(<AgentSessionView source={{ kind: 'flight', flightId: 'flight', stage: 'docs' }} openLogId={openLogId} onOpenLogChange={onOpenLogChange} />))
    return onOpenLogChange
  }
  const rowLogs = () => [...container.querySelectorAll<HTMLElement>('li[data-kind="agent"] .agentts-log')]
  const modal = () => container.querySelector('[data-testid="activity-log-modal"]')

  it('opens the entry the route names, selected, and reports clicks instead of opening itself', async () => {
    const onChange = await render(id(1))
    expect(modal()?.textContent).toContain('With detail.')
    expect(rowLogs().map((row) => row.getAttribute('data-selected'))).toEqual(['false', 'true', null])

    await act(async () => rowLogs()[0].click())
    expect(onChange).toHaveBeenCalledWith(id(0))
    // The route owns what is open: until it changes, the routed entry stays.
    expect(modal()?.textContent).toContain('Second finding.')
  })

  it('asks the route to close, and keeps the highlight once it has', async () => {
    const onChange = await render(id(1))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click())
    expect(onChange).toHaveBeenCalledWith(null)

    await render(null, onChange)
    expect(modal()).toBeNull()
    expect(rowLogs()[1].getAttribute('data-selected')).toBe('true')
  })

  it('opens nothing for a routed id that matches no row, or names a one-line row', async () => {
    await render('flight:flight:docs:event:9')
    expect(modal()).toBeNull()
    await render(id(2))
    expect(modal()).toBeNull()
    expect(rowLogs()[2].getAttribute('data-whole')).toBe('true')
  })
})

describe('Subagent row and its modal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const call: AgentSessionEvent = {
    kind: 'tool-call', timestamp: '2026-07-21T11:30:59.000Z', toolId: 't1', name: 'Task',
    input: { subagent_type: 'Explore', description: 'find things', prompt: 'Find the auth code.' },
  }
  const render = async (thread: ReturnType<typeof child>): Promise<void> => {
    mocks.get.mockResolvedValue({ agent: 'claude', sessionId: 'parent', events: [call], subagents: [thread] })
    await act(async () => root.render(<AgentSessionView source={{ kind: 'flight', flightId: 'flight', stage: 'docs' }} />))
  }
  const row = () => container.querySelector<HTMLButtonElement>('li[data-kind="agent"] .agentts-log')!
  const modal = () => container.querySelector('[data-testid="activity-log-modal"]')
  const threadRows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="activity-log-thread"] .agentts-log')]

  it('summarizes the thread on one row — the "is it stuck?" answer without opening it', async () => {
    await render(child('a', 't1', [text('2026-07-21T11:31:00.000Z', 'one'), text('2026-07-21T11:33:00.000Z', 'two')]))
    expect(row().querySelector('.agentts-logverb')?.textContent).toBe('Subagent')
    expect(row().querySelector('.agentts-logsum')?.textContent).toBe('Explore · find things · 2 events · 2m 00s')
  })

  it('opens on the task it was given and its thread, and drills into one event with a way back', async () => {
    await render(child('a', 't1', [text('2026-07-21T11:31:00.000Z', 'one'), text('2026-07-21T11:33:00.000Z', 'two\nwith more')]))
    await act(async () => row().click())
    expect(modal()?.textContent).toContain('Task given · Explore')
    expect(modal()?.textContent).toContain('Find the auth code.')
    expect(threadRows()).toHaveLength(2)
    // A one-line nested event is shown whole; only the cut one opens.
    expect(threadRows()[0].tagName).toBe('DIV')
    await act(async () => threadRows()[1].click())
    // The nested event replaces the modal's content — no modal over a modal.
    expect(container.querySelectorAll('[data-testid="activity-log-modal"]')).toHaveLength(1)
    expect(modal()?.textContent).toContain('two')
    expect(container.querySelector('[data-testid="activity-log-thread"]')).toBeNull()
    const back = container.querySelector<HTMLButtonElement>('[data-testid="activity-log-back"]')!
    expect(back.textContent).toContain('Explore')
    await act(async () => back.click())
    expect(threadRows()).toHaveLength(2)
  })

  it('marks a thread that died on an API error in its nested rows', async () => {
    await render(child('a', 't1', [
      text('2026-07-21T11:31:00.000Z', 'partial thought'),
      text('2026-07-21T11:33:00.000Z', 'API Error: Connection closed mid-response.', true),
    ]))
    await act(async () => row().click())
    expect(threadRows().map((nested) => nested.getAttribute('data-danger'))).toEqual(['false', 'true'])
  })

  it('tolerates a sparse events array from out-of-order streaming', async () => {
    const sparse = child('a', 't1')
    sparse.events[2] = text('2026-07-21T11:31:00.000Z', 'late arrival')
    await render(sparse)
    expect(row().querySelector('.agentts-logsum')?.textContent).toContain('1 event')
    await act(async () => row().click())
    expect(threadRows()).toHaveLength(1)
  })
})

describe('AgentSessionView external session', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    container.remove()
  })

  const status = () => container.querySelector('[data-testid="external-session-status"]')?.textContent

  it('opens a live external session with its own divider, client, session and elapsed time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:01:42.000Z'))
    act(() => root.render(
      <AgentSessionView externalSessions={[{
        clientKind: 'claude',
        sessionId: '649945f5-79b7-43ae-81c9-be02b0911e88',
        status: 'running',
        message: 'Work is continuing in your Claude session.',
        startedAt: '2026-08-25T00:00:00.000Z',
      }]} />,
    ))

    const header = container.querySelector('[data-testid="external-session-header"]')
    expect(header?.textContent).toContain('External agent session')
    expect(container.querySelector('[data-testid="external-session-client"]')?.textContent).toBe('Claude')
    expect(container.querySelector('[data-testid="external-session-id"]')?.textContent).toBe('649945…1e88')
    expect(container.querySelector('[data-testid="external-session-id"]')?.getAttribute('title'))
      .toBe('649945f5-79b7-43ae-81c9-be02b0911e88')
    expect(status()).toBe('Live · 1m 42s')
    const start = container.querySelector('[data-testid="external-session-start"]')
    expect(start?.querySelector('.agentts-logverb')?.textContent).toBe('Running')
    expect(start?.textContent).toContain('Work is continuing in your Claude session.')
    expect(container.querySelector('[data-testid="external-session-end"]')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('.agentts-extaction')?.textContent).toContain('Open Claude app')
    expect(container.querySelector<HTMLButtonElement>('.agentts-extaction')?.title).toContain('No exact session link')
  })

  it('closes a finished session with its outcome and links back to the exact conversation', () => {
    act(() => root.render(
      <AgentSessionView externalSessions={[{
        clientKind: 'codex',
        sessionId: 'codex-session-abc',
        status: 'done',
        message: 'Completed outside Canary Lab · 3 files applied.',
        startedAt: '2026-08-25T00:00:00.000Z',
        endedAt: '2026-08-25T00:05:00.000Z',
        sessionUrl: 'codex://session/abc',
      }]} />,
    ))

    expect(container.querySelector('[data-testid="external-session-client"]')?.textContent).toBe('Codex')
    expect(status()).toBe('Completed · 5m 00s')
    const end = container.querySelector('[data-testid="external-session-end"]')!
    expect(end.querySelector('.agentts-logverb')?.textContent).toBe('Completed')
    expect(end.textContent).toContain('Completed outside Canary Lab · 3 files applied.')
    expect(container.querySelector<HTMLAnchorElement>('.agentts-extaction')?.getAttribute('href')).toBe('codex://session/abc')
    expect(container.querySelector<HTMLAnchorElement>('.agentts-extaction')?.textContent).toContain('Open in Codex')
    // One line of outcome: the row already says it all.
    expect(end.querySelector('button')).toBeNull()
  })

  it('opens an outcome too long for its row, with where the conversation lives', () => {
    act(() => root.render(
      <AgentSessionView externalSessions={[{
        clientKind: 'codex', status: 'done', message: 'Completed outside Canary Lab.\n3 files applied.',
        startedAt: '2026-08-25T00:00:00.000Z', endedAt: '2026-08-25T00:05:00.000Z',
      }]} />,
    ))
    const end = container.querySelector('[data-testid="external-session-end"]')!
    expect(end.querySelector('.agentts-logsum')?.textContent).toBe('Completed outside Canary Lab.')
    act(() => end.querySelector('button')!.click())
    const modal = container.querySelector('[data-testid="activity-log-modal"]')
    expect(modal?.textContent).toContain('3 files applied.')
    expect(modal?.textContent).toContain('The conversation itself lives in Codex.')
    expect(container.querySelector('[data-testid="activity-log-meta"]')?.textContent).toContain('5m 00s')
  })

  it('keeps every external pass instead of replacing the prior one', () => {
    act(() => root.render(
      <AgentSessionView externalSessions={[
        {
          clientKind: 'other',
          status: 'done',
          message: 'First coverage pass completed.',
          startedAt: '2026-08-25T00:00:00.000Z',
          endedAt: '2026-08-25T00:01:00.000Z',
        },
        {
          clientKind: 'claude',
          status: 'done',
          message: 'Second coverage pass completed.',
          startedAt: '2026-08-25T00:02:00.000Z',
          endedAt: '2026-08-25T00:03:00.000Z',
        },
      ]} />,
    ))

    expect(container.querySelectorAll('[data-testid="external-session-header"]')).toHaveLength(2)
    const ends = container.querySelectorAll('[data-testid="external-session-end"]')
    expect(ends[0]?.textContent).toContain('First coverage pass completed.')
    expect(ends[1]?.textContent).toContain('Second coverage pass completed.')
    // An unnamed client is not named twice: the divider already says External.
    expect(container.querySelectorAll('[data-testid="external-session-client"]')).toHaveLength(1)
  })

  it('places the external session after the conductor lines that announced the hand-off', () => {
    act(() => root.render(
      <AgentSessionView
        systemRows={{
          pre: ['[autopilot] prd-source: answered "collect-repo-docs"'],
          post: ['[docs] handed the collect repo docs step to the external agent session…'],
        }}
        externalSessions={[{
          clientKind: 'other',
          status: 'running',
          message: 'Work is continuing in your external agent session.',
          startedAt: '2026-08-25T00:00:00.000Z',
        }]}
      />,
    ))

    const rows = [...container.querySelectorAll('.agentts-rail > li[data-activity-id]')]
    expect(rows.at(-1)?.getAttribute('data-testid')).toBe('external-session-start')
    expect(rows.at(-2)?.getAttribute('data-testid')).toBe('external-session-segment')
    expect(rows.at(-3)?.textContent).toContain('handed the collect repo docs step to the external agent session')
  })
})
