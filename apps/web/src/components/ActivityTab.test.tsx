// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityTab } from './ActivityTab'
import * as api from '../api/client'
import type { AuditList } from '../api/types'

let container: HTMLDivElement
let root: Root

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('ActivityTab', () => {
  it('renders an empty state when no audit entries exist', async () => {
    vi.spyOn(api, 'getRunAudit').mockResolvedValue({ entries: [] } satisfies AuditList)

    await act(async () => {
      root.render(<ActivityTab runId="run-1" runStatus="failed" />)
    })
    await act(async () => { await flush() })

    expect(container.textContent).toContain('No external client activity recorded for this run.')
  })

  it('renders audit entries with tool name, time, session, and client kind', async () => {
    vi.spyOn(api, 'getRunAudit').mockResolvedValue({
      entries: [
        {
          ts: '2026-05-27T10:00:01.000Z',
          sessionId: 'sess-abcdef',
          clientKind: 'claude-desktop',
          action: 'claim',
          args: { conversationName: 'fix checkout' },
        },
        {
          ts: '2026-05-27T10:00:05.000Z',
          sessionId: 'sess-abcdef',
          clientKind: 'claude-desktop',
          action: 'handoff',
          args: { to: 'manual' },
        },
      ],
    })

    await act(async () => {
      root.render(<ActivityTab runId="run-1" runStatus="failed" />)
    })
    await act(async () => { await flush() })

    const text = container.textContent ?? ''
    expect(text).toContain('claim')
    expect(text).toContain('handoff')
    expect(text).toContain('Claude Desktop')
    expect(text).toContain('2 events from external clients')
  })

  it('polls /api/runs/:runId/audit every 2s while the run is active', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(api, 'getRunAudit').mockResolvedValue({ entries: [] } satisfies AuditList)

    await act(async () => {
      root.render(<ActivityTab runId="run-1" runStatus="running" />)
    })
    await act(async () => { await Promise.resolve() })

    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(spy).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('does not poll when the run is terminal', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(api, 'getRunAudit').mockResolvedValue({ entries: [] } satisfies AuditList)

    await act(async () => {
      root.render(<ActivityTab runId="run-1" runStatus="passed" />)
    })
    await act(async () => { await Promise.resolve() })

    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })

    expect(spy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
