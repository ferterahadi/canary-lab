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
  options: [] as Record<string, unknown>[],
  scrollToBottoms: 0,
  instances: [] as Array<{
    buffer: { active: { viewportY: number; baseY: number } }
    emitScroll: (viewportY: number, baseY?: number) => void
  }>,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    buffer = { active: { viewportY: 0, baseY: 0 } }
    private scrollHandlers: Array<() => void> = []
    constructor(opts: Record<string, unknown>) {
      this.options = opts
      terminalState.options.push(opts)
      terminalState.instances.push(this)
    }
    loadAddon(): void {}
    open(): void {}
    onScroll(handler: () => void): { dispose: () => void } {
      this.scrollHandlers.push(handler)
      return {
        dispose: () => {
          this.scrollHandlers = this.scrollHandlers.filter((current) => current !== handler)
        },
      }
    }
    write(text: string): void {
      terminalState.writes.push(text)
    }
    reset(): void {
      terminalState.resets += 1
    }
    scrollToBottom(): void {
      terminalState.scrollToBottoms += 1
      this.buffer.active.viewportY = this.buffer.active.baseY
    }
    emitScroll(viewportY: number, baseY = this.buffer.active.baseY): void {
      this.buffer.active.viewportY = viewportY
      this.buffer.active.baseY = baseY
      this.scrollHandlers.forEach((handler) => handler())
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
  terminalState.options = []
  terminalState.scrollToBottoms = 0
  terminalState.instances = []
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
  if (!('requestAnimationFrame' in window)) {
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0)
      return 0
    }) as typeof window.requestAnimationFrame
  }
  if (!('cancelAnimationFrame' in window)) {
    window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame
  }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('AgentLogPanel', () => {
  it('keeps a large terminal scrollback for full wizard output review', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: 'full log\n' })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" />)
    })

    expect(terminalState.options[0]?.scrollback).toBe(100_000)
  })

  it('fills available wizard space while generation is running', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: 'full log\n' })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" status="running" variant="fill" />)
    })

    expect(container.innerHTML).toContain('h-full')
    expect(container.innerHTML).toContain('flex-1')
    expect(container.innerHTML).toContain('overflow-hidden')
    expect(container.innerHTML).not.toContain('h-[min(52vh,34rem)]')
  })

  it('caps the visible log panel height so stopped output scrolls internally', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: 'full log\n' })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="generating" status="idle" variant="bounded" />)
    })

    expect(container.innerHTML).toContain('max-h-')
    expect(container.innerHTML).toContain('h-[min(52vh,34rem)]')
    expect(container.innerHTML).toContain('overflow-hidden')
  })

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

  it('buffers live websocket chunks while the user is browsing earlier output', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: 'full log\n' })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" status="running" />)
    })

    const term = terminalState.instances[0]
    act(() => {
      term.emitScroll(4, 12)
    })
    const before = terminalState.writes.join('')
    const opts = vi.mocked(connectDraftAgent).mock.calls[0][0] as ConnectDraftAgentOptions
    act(() => {
      opts.onData('hidden live line 1\nhidden live line 2\n')
    })

    expect(terminalState.writes.join('')).toBe(before)
    expect(container.textContent).toContain('2 new lines')
    expect(container.textContent).toContain('Jump latest')
  })

  it('flushes buffered live chunks when Jump latest is clicked', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: 'full log\n' })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" status="running" />)
    })

    const term = terminalState.instances[0]
    act(() => {
      term.emitScroll(4, 12)
    })
    const opts = vi.mocked(connectDraftAgent).mock.calls[0][0] as ConnectDraftAgentOptions
    act(() => {
      opts.onData('buffered line\n')
    })

    const button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Jump latest'))
    expect(button).toBeTruthy()
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(terminalState.writes.join('')).toContain('buffered line')
    expect(terminalState.scrollToBottoms).toBeGreaterThan(0)
    expect(container.textContent).not.toContain('Jump latest')
  })

  it('flushes buffered chunks when the user scrolls back to the bottom', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: 'full log\n' })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" status="running" />)
    })

    const term = terminalState.instances[0]
    const opts = vi.mocked(connectDraftAgent).mock.calls[0][0] as ConnectDraftAgentOptions
    act(() => {
      term.emitScroll(4, 12)
      opts.onData('buffered by scroll\n')
    })
    expect(terminalState.writes.join('')).not.toContain('buffered by scroll')

    act(() => {
      term.emitScroll(12, 12)
    })

    expect(terminalState.writes.join('')).toContain('buffered by scroll')
    expect(container.textContent).not.toContain('Jump latest')
  })

  it('keeps stopped output bounded after live browse buffering', async () => {
    vi.mocked(getDraftAgentLog).mockResolvedValue({ content: 'full log\n' })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" status="running" variant="fill" />)
    })

    const term = terminalState.instances[0]
    const opts = vi.mocked(connectDraftAgent).mock.calls[0][0] as ConnectDraftAgentOptions
    act(() => {
      term.emitScroll(4, 12)
      opts.onData('buffered while running\n')
    })

    await act(async () => {
      root.render(<AgentLogPanel draftId="d1" phase="planning" status="idle" variant="bounded" />)
    })

    expect(container.innerHTML).toContain('max-h-')
    expect(container.innerHTML).toContain('h-[min(52vh,34rem)]')
    expect(container.textContent).not.toContain('Jump latest')
    expect(terminalState.writes.join('')).toContain('buffered while running')
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
