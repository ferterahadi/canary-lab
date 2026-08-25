// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionEvent } from '@/shared/api/client'
import { AgentSessionView, Markdown, SubagentThreadRow, SystemRow, groupSystemLines, indexSubagents, mergeSubagentEvent } from './AgentSessionView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('SystemRow (flight conductor line on the agent rail)', () => {
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
    act(() => root.render(<>{groupSystemLines(lines).map((g, i) => <SystemRow key={i} group={g} />)}</>))
  }
  const texts = (): string[] =>
    Array.from(container.querySelectorAll('.agentts-systext')).map((n) => n.textContent ?? '')

  it('splits `[TAG] text` into the tag label and the message', () => {
    render('[boot-verify] all services ready')
    expect(container.querySelector('.agentts-sysrow')).not.toBeNull()
    expect(container.querySelector('.agentts-systag')?.textContent).toBe('boot-verify')
    expect(texts()).toEqual(['all services ready'])
    // Boxy terminal node marks it as system, not an agent event.
    expect(container.querySelector('.agentts-sysnode')).not.toBeNull()
  })

  it('heads a stamped run with its time, and keeps the message clean', () => {
    render('[docs@2026-07-22T20:35:24.000Z] collecting repo docs…')
    expect(container.querySelector('.agentts-systag')?.textContent).toBe('docs')
    expect(container.querySelector('.agentts-time')).not.toBeNull()
    // The rendered clock is local-time, so assert the source instant instead.
    expect(container.querySelector('.agentts-rowhead span[title]')?.getAttribute('title'))
      .toBe('2026-07-22T20:35:24.000Z')
    expect(texts()).toEqual(['collecting repo docs…'])
  })

  it('parses an unstamped line from an older flight, just without a time', () => {
    render('[docs] collecting repo docs…')
    expect(container.querySelector('.agentts-systag')?.textContent).toBe('docs')
    expect(container.querySelector('.agentts-rowhead span[title]')).toBeNull()
    expect(texts()).toEqual(['collecting repo docs…'])
  })

  it('dates a mixed run from its first stamped line when it opened undated', () => {
    // A flight that spanned the stamping change: the specs run wrote undated
    // lines first, then dated ones on resume. The group must still show a time.
    render(
      '[specs] iteration 1: 0% / 100% — 6 gap(s)',
      '[specs] spec files rejected: no generated files',
      '[specs@2026-07-22T04:00:55.373Z] iteration 2: 0% / 100% — 6 gap(s)',
      '[specs@2026-07-22T04:00:56.001Z] validated 1 file(s)',
    )
    // One run, headed by the FIRST timestamp it found — not left undated because
    // the opening line had none.
    expect(container.querySelectorAll('.agentts-sysrow')).toHaveLength(1)
    expect(container.querySelector('.agentts-rowhead span[title]')?.getAttribute('title'))
      .toBe('2026-07-22T04:00:55.373Z')
  })

  it('splits a same-tag run at a stamp gap — each stage re-entry heads on its own time', () => {
    // Portify's stage log accumulates one `workflow … started` line per stage
    // entry (resume/retry appends; only redo wipes). Folding them under the
    // FIRST stamp dated today's workflow with yesterday's clock — each visit
    // must be its own dated row instead.
    render(
      '[portify@2026-07-22T17:15:27.000Z] workflow portify-2026-07-22T1715-m81h started',
      '[portify@2026-07-22T17:42:03.000Z] workflow portify-2026-07-22T1742-vqqq started',
      '[portify@2026-07-23T02:27:52.000Z] workflow portify-2026-07-23T0227-v3k8 started',
    )
    expect(container.querySelectorAll('.agentts-sysrow')).toHaveLength(3)
    expect(Array.from(container.querySelectorAll('.agentts-rowhead span[title]')).map((n) => n.getAttribute('title'))).toEqual([
      '2026-07-22T17:15:27.000Z',
      '2026-07-22T17:42:03.000Z',
      '2026-07-23T02:27:52.000Z',
    ])
  })

  it('keeps a burst of stamped lines seconds apart as one run', () => {
    render(
      '[env@2026-07-23T02:27:52.000Z] captured 2 file(s) into envsets/local/',
      '[env@2026-07-23T02:28:10.000Z] wrote 3 value(s) to .env',
    )
    expect(container.querySelectorAll('.agentts-sysrow')).toHaveLength(1)
    expect(container.querySelector('.agentts-rowhead span[title]')?.getAttribute('title'))
      .toBe('2026-07-23T02:27:52.000Z')
  })

  it('renders an untagged line verbatim with no tag label', () => {
    render('plain conductor note')
    expect(container.querySelector('.agentts-systag')).toBeNull()
    expect(texts()).toEqual(['plain conductor note'])
  })

  it('prints the tag once for a run of same-tag lines', () => {
    render('[docs] scanning repos', '[docs] collecting repo docs…')
    // One row for the run, and the tag heads it once — on its own line, above
    // the messages (same head/body shape as an agent row).
    expect(container.querySelectorAll('.agentts-sysrow')).toHaveLength(1)
    expect(Array.from(container.querySelectorAll('.agentts-systag')).map((n) => n.textContent)).toEqual([
      'docs',
    ])
    expect(container.querySelector('.agentts-sysbody')?.firstElementChild?.className).toContain('agentts-rowhead')
    expect(texts()).toEqual(['scanning repos', 'collecting repo docs…'])
  })

  it('collapses an identical repeated line into one entry with a count', () => {
    render('[docs] no meaningful diff vs base', '[docs] no meaningful diff vs base', '[docs] done')
    expect(texts()).toEqual(['no meaningful diff vs base×2', 'done'])
    expect(container.querySelector('.agentts-sysrepeat')?.textContent).toBe('×2')
  })

  it('starts a new row when the tag changes', () => {
    render('[docs] a', '[run] b')
    expect(container.querySelectorAll('.agentts-sysrow')).toHaveLength(2)
    expect(Array.from(container.querySelectorAll('.agentts-systag')).map((n) => n.textContent)).toEqual([
      'docs',
      'run',
    ])
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

describe('SubagentThreadRow', () => {
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

  const render = (thread: ReturnType<typeof child>): void => {
    act(() => root.render(<SubagentThreadRow thread={thread} />))
  }

  it('summarizes the thread without expanding — the "is it stuck?" answer', () => {
    render(child('a', 't1', [text('2026-07-21T11:31:00.000Z', 'one'), text('2026-07-21T11:33:00.000Z', 'two')]))
    expect(container.textContent).toContain('Explore')
    expect(container.textContent).toContain('2 events')
    expect(container.textContent).toContain('2m 0s')
  })

  it('collapses a finished thread — its conclusion already reached the parent rail', () => {
    render(child('a', 't1', [text('2026-07-21T11:31:00.000Z', 'done here')]))
    expect(container.textContent).toContain('done')
    expect(container.textContent).not.toContain('done here')
  })

  it('auto-expands a thread that died, and labels it a termination not a conclusion', () => {
    render(child('a', 't1', [
      text('2026-07-21T11:31:00.000Z', 'partial thought'),
      text('2026-07-21T11:33:00.000Z', 'API Error: Connection closed mid-response.', true),
    ]))
    expect(container.textContent).toContain('terminated')
    expect(container.textContent).toContain('Terminated · API error')
    // Expanded, so the recovered partial output is visible in context.
    expect(container.textContent).toContain('partial thought')
  })

  it('auto-expands a thread still mid-tool-call and flags it live', () => {
    render(child('a', 't1', [
      text('2026-07-21T11:31:00.000Z', 'looking'),
      { kind: 'tool-call', timestamp: '2026-07-21T11:31:05.000Z', toolId: 'x', name: 'Bash', input: { command: 'ls' } },
    ]))
    expect(container.querySelector('.agentts-sublive')).not.toBeNull()
    expect(container.textContent).not.toContain('done')
    expect(container.textContent).toContain('Bash')
  })

  it('tolerates a sparse events array from out-of-order streaming', () => {
    const sparse = child('a', 't1')
    sparse.events[2] = text('2026-07-21T11:31:00.000Z', 'late arrival')
    render(sparse)
    expect(container.textContent).toContain('1 event')
  })
})

describe('AgentSessionView external-session Activity row', () => {
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

  it('shows a live external session with the shared working pulse and elapsed time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:01:42.000Z'))
    act(() => root.render(
      <AgentSessionView externalSessions={[{
        clientKind: 'claude',
        status: 'running',
        message: 'Work is continuing in your Claude session.',
        startedAt: '2026-08-25T00:00:00.000Z',
      }]} />,
    ))

    const row = container.querySelector('[data-testid="external-session-activity"]')
    expect(row?.textContent).toContain('External session')
    expect(row?.textContent).not.toContain('External · Claude')
    expect(row?.textContent).toContain('Work is continuing in your Claude session.')
    expect(container.querySelector('[data-testid="external-session-elapsed"]')?.textContent).toBe('1m 42s')
    expect(container.querySelector('.agentts-worknode')).not.toBeNull()
  })

  it('keeps completed external provenance compact and links back to the session', () => {
    act(() => root.render(
      <AgentSessionView externalSessions={[{
        clientKind: 'codex',
        status: 'done',
        message: 'Completed outside Canary Lab · 3 files applied.',
        startedAt: '2026-08-25T00:00:00.000Z',
        endedAt: '2026-08-25T00:05:00.000Z',
        sessionUrl: 'codex://session/abc',
      }]} />,
    ))

    const row = container.querySelector('[data-testid="external-session-activity"]')
    expect(row?.textContent).toContain('External session')
    expect(row?.textContent).toContain('Completed outside Canary Lab · 3 files applied.')
    expect(container.querySelector('[data-testid="external-session-elapsed"]')?.textContent).toBe('5m 00s')
    expect(container.querySelector<HTMLAnchorElement>('.agentts-extaction')?.getAttribute('href')).toBe('codex://session/abc')
    expect(container.querySelector('.agentts-worknode')).toBeNull()
  })

  it('renders every external pass instead of replacing the prior row', () => {
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

    const rows = container.querySelectorAll('[data-testid="external-session-activity"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('First coverage pass completed.')
    expect(rows[1]?.textContent).toContain('Second coverage pass completed.')
    expect([...rows].every((row) => row.textContent?.includes('External session'))).toBe(true)
  })
})
