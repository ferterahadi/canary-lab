// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDraftAgentLog } from '../../api/client'
import { connectDraftAgent, type ConnectDraftAgentOptions } from '../../api/draft-socket'
import { AgentLogPanel } from './AgentLogPanel'

const terminalState = vi.hoisted(() => ({
  writes: [] as string[],
  resets: 0,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    constructor(opts: Record<string, unknown>) {
      this.options = opts
    }
    loadAddon(): void {}
    open(): void {}
    write(text: string): void {
      terminalState.writes.push(text)
    }
    reset(): void {
      terminalState.resets += 1
    }
    dispose(): void {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}))

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client')
  return {
    ...actual,
    getDraftAgentLog: vi.fn(),
  }
})

vi.mock('../../api/draft-socket', () => ({
  connectDraftAgent: vi.fn(() => ({ close: vi.fn() })),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  terminalState.writes = []
  terminalState.resets = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(getDraftAgentLog).mockReset()
  vi.mocked(connectDraftAgent).mockClear()
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    } as typeof ResizeObserver
  }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('AgentLogPanel', () => {
  it('fetches and writes the full persisted agent log', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: `line 1\n${'x'.repeat(5000)}\nline end` })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" initialBuffer="tail only" />)
    })

    expect(getDraftAgentLog).toHaveBeenCalledWith('d1', 'planning')
    expect(terminalState.writes.join('')).toContain('line 1')
    expect(terminalState.writes.join('')).toContain('line end')
  })

  it('falls back to the initial tail when full log fetch fails', async () => {
    vi.mocked(getDraftAgentLog).mockRejectedValue(new Error('missing'))

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="generating" initialBuffer="tail only" />)
    })

    expect(getDraftAgentLog).toHaveBeenCalledWith('d1', 'generating')
    expect(terminalState.writes.join('')).toContain('tail only')
  })

  it('appends live websocket chunks after the full log loads', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: 'full log\n' })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" />)
    })

    const opts = vi.mocked(connectDraftAgent).mock.calls[0][0] as ConnectDraftAgentOptions
    act(() => {
      opts.onData('live chunk\n')
    })

    expect(terminalState.writes.join('')).toContain('full log')
    expect(terminalState.writes.join('')).toContain('live chunk')
  })

  it('drops the websocket replay chunk when it duplicates the full log', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: 'full log\n' })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" />)
    })

    const before = terminalState.writes.join('')
    const opts = vi.mocked(connectDraftAgent).mock.calls[0][0] as ConnectDraftAgentOptions
    act(() => {
      opts.onData('full log\n')
    })

    expect(terminalState.writes.join('')).toBe(before)
  })
})
