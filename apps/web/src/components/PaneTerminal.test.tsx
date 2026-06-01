// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectPane, type ConnectPaneOptions, type PaneConnection } from '../api/pane-socket'
import { PaneTerminal } from './PaneTerminal'

const terminalState = vi.hoisted(() => ({
  writes: [] as string[],
  fitCalls: 0,
  webglAddonCtorCalls: 0,
  instances: [] as Array<{
    cols: number
    rows: number
    dataHandlers: Array<(data: string) => void>
    loadedAddons: unknown[]
  }>,
}))

const paneState = vi.hoisted(() => ({
  options: [] as ConnectPaneOptions[],
  connections: [] as Array<PaneConnection & { sendResize: ReturnType<typeof vi.fn>; sendInput: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
}))

const resizeState = vi.hoisted(() => ({
  observers: [] as Array<{ callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    dataHandlers: Array<(data: string) => void> = []
    loadedAddons: unknown[] = []
    constructor(opts: Record<string, unknown>) {
      this.options = opts
      terminalState.instances.push(this)
    }
    loadAddon(addon: unknown): void {
      this.loadedAddons.push(addon)
    }
    open(): void {}
    write(text: string): void {
      terminalState.writes.push(text)
    }
    writeln(text: string): void {
      terminalState.writes.push(text)
    }
    clear(): void {}
    attachCustomKeyEventHandler(): void {}
    onData(handler: (data: string) => void): { dispose: () => void } {
      this.dataHandlers.push(handler)
      return { dispose: () => {} }
    }
    dispose(): void {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      terminalState.fitCalls += 1
    }
  },
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      terminalState.webglAddonCtorCalls += 1
    }
    onContextLoss(_handler: () => void): void {}
    dispose(): void {}
  },
}))

vi.mock('../api/pane-socket', () => ({
  connectPane: vi.fn((opts: ConnectPaneOptions) => {
    const conn = {
      sendResize: vi.fn(),
      sendInput: vi.fn(),
      close: vi.fn(),
    }
    paneState.options.push(opts)
    paneState.connections.push(conn)
    return conn
  }),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  terminalState.writes = []
  terminalState.fitCalls = 0
  terminalState.webglAddonCtorCalls = 0
  terminalState.instances = []
  paneState.options = []
  paneState.connections = []
  resizeState.observers = []
  vi.mocked(connectPane).mockClear()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 })
  ;(globalThis as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    callback: ResizeObserverCallback
    observe = vi.fn()
    disconnect = vi.fn()
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      resizeState.observers.push(this)
    }
  } as typeof ResizeObserver
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('PaneTerminal', () => {
  it('one-shot fits the agent pane when its container is first measured, ignoring streamed output', async () => {
    await act(async () => {
      root.render(<PaneTerminal runId="r1" paneId="agent" />)
    })

    // Agent pane gets a one-shot ResizeObserver: PaneTerminal now stays mounted
    // across tab switches, so the initial mount can be inside a hidden parent
    // (0×0 container) where the inline fit short-circuits. The observer fits
    // exactly once when real dims arrive, then disconnects to avoid a flicker
    // loop with the Ink TUI's redraw-on-SIGWINCH behavior.
    expect(resizeState.observers).toHaveLength(1)
    const observer = resizeState.observers[0]
    expect(observer.observe).toHaveBeenCalledTimes(1)

    act(() => {
      paneState.options[0].onOpen?.()
    })

    expect(paneState.connections[0].sendResize).toHaveBeenCalledTimes(1)
    expect(paneState.connections[0].sendResize).toHaveBeenLastCalledWith(80, 24)
    const fitCallsAfterOpen = terminalState.fitCalls

    act(() => {
      paneState.options[0].onData('streamed output')
    })

    expect(terminalState.writes).toContain('streamed output')
    expect(paneState.connections[0].sendResize).toHaveBeenCalledTimes(1)
    expect(terminalState.fitCalls).toBe(fitCallsAfterOpen)

    // Container reaches real dims → observer fires → fit + pty resize once, then disconnect.
    act(() => {
      observer.callback([], observer as unknown as ResizeObserver)
    })
    expect(terminalState.fitCalls).toBe(fitCallsAfterOpen + 1)
    expect(paneState.connections[0].sendResize).toHaveBeenCalledTimes(2)
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
  })

  it('fits non-agent panes when their container resize observer fires', async () => {
    await act(async () => {
      root.render(<PaneTerminal runId="r1" paneId="playwright" />)
    })

    expect(resizeState.observers).toHaveLength(1)
    const fitCallsBeforeResize = terminalState.fitCalls
    act(() => {
      resizeState.observers[0].callback([], resizeState.observers[0] as unknown as ResizeObserver)
    })

    expect(terminalState.fitCalls).toBe(fitCallsBeforeResize + 1)
  })

  it('notifies the parent when the agent pane exits', async () => {
    const onExit = vi.fn()
    await act(async () => {
      root.render(<PaneTerminal runId="r1" paneId="agent" onExit={onExit} />)
    })

    act(() => {
      paneState.options[0].onExit?.(0)
    })

    expect(onExit).toHaveBeenCalledWith(0)
    expect(terminalState.writes).toContain('\r\nPane exited code=0')
  })

  it('shows the empty-state placeholder after the grace window, then hides it once output streams', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => {
        root.render(
          <PaneTerminal
            runId="r1"
            paneId="playwright"
            emptyState={{ title: 'Playwright', hint: 'Test output appears here.' }}
          />,
        )
      })

      // During the grace window the placeholder is suppressed (buffered output
      // may still be replaying), so the pane stays bare.
      expect(container.textContent).not.toContain('Playwright')

      act(() => {
        vi.advanceTimersByTime(700)
      })
      expect(container.textContent).toContain('Playwright')
      expect(container.textContent).toContain('Test output appears here.')

      // First streamed chunk → the pane has content, placeholder disappears.
      act(() => {
        paneState.options[0].onData?.('hello world')
      })
      expect(container.textContent).not.toContain('Playwright')
    } finally {
      vi.useRealTimers()
    }
  })

  it('omits the placeholder entirely when no emptyState is provided', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => {
        root.render(<PaneTerminal runId="r1" paneId="agent" />)
      })
      act(() => {
        vi.advanceTimersByTime(700)
      })
      expect(container.textContent).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads the WebGL renderer for the agent pane only', async () => {
    await act(async () => {
      root.render(<PaneTerminal runId="r1" paneId="agent" />)
    })
    expect(terminalState.webglAddonCtorCalls).toBe(1)
    expect(terminalState.instances[0].loadedAddons).toHaveLength(2) // fit + webgl

    terminalState.webglAddonCtorCalls = 0
    terminalState.instances = []

    await act(async () => {
      root.render(<PaneTerminal runId="r1" paneId="playwright" />)
    })
    expect(terminalState.webglAddonCtorCalls).toBe(0)
    expect(terminalState.instances[0].loadedAddons).toHaveLength(1) // fit only
  })
})
