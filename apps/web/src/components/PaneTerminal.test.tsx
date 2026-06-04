// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectPane, type ConnectPaneOptions, type PaneConnection } from '../api/pane-socket'
import { PaneTerminal } from './PaneTerminal'

const terminalState = vi.hoisted(() => ({
  writes: [] as string[],
  openCalls: 0,
  fitCalls: 0,
  // What FitAddon.proposeDimensions() returns. The component only forwards a
  // PTY resize when these differ from the mock Terminal's fixed 80×24 grid, so
  // tests flip this to simulate a real geometry change vs. a no-op resize.
  proposedDimensions: { cols: 80, rows: 24 } as { cols: number; rows: number } | undefined,
  refreshCalls: 0,
  clearTextureAtlasCalls: 0,
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
    open(): void {
      terminalState.openCalls += 1
    }
    write(text: string): void {
      terminalState.writes.push(text)
    }
    writeln(text: string): void {
      terminalState.writes.push(text)
    }
    clear(): void {}
    refresh(): void {
      terminalState.refreshCalls += 1
    }
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
    proposeDimensions(): { cols: number; rows: number } | undefined {
      return terminalState.proposedDimensions
    }
  },
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      terminalState.webglAddonCtorCalls += 1
    }
    onContextLoss(_handler: () => void): void {}
    clearTextureAtlas(): void {
      terminalState.clearTextureAtlasCalls += 1
    }
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
  terminalState.openCalls = 0
  terminalState.fitCalls = 0
  terminalState.proposedDimensions = { cols: 80, rows: 24 }
  terminalState.refreshCalls = 0
  terminalState.clearTextureAtlasCalls = 0
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
  it('keeps re-fitting the agent pane on resize, debounced and only when the grid changes', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => {
        root.render(<PaneTerminal runId="r1" paneId="agent" />)
      })

      expect(resizeState.observers).toHaveLength(1)
      const observer = resizeState.observers[0]
      expect(observer.observe).toHaveBeenCalledTimes(1)

      act(() => {
        paneState.options[0].onOpen?.()
      })
      expect(paneState.connections[0].sendResize).toHaveBeenCalledTimes(1)
      expect(paneState.connections[0].sendResize).toHaveBeenLastCalledWith(80, 24)
      const fitCallsAfterOpen = terminalState.fitCalls

      // Streamed output never triggers a fit or a PTY resize — only geometry does.
      act(() => {
        paneState.options[0].onData('streamed output')
      })
      expect(terminalState.writes).toContain('streamed output')
      expect(paneState.connections[0].sendResize).toHaveBeenCalledTimes(1)
      expect(terminalState.fitCalls).toBe(fitCallsAfterOpen)

      // A burst of observer fires (e.g. a splitter drag) collapses into a
      // single debounced fit, and forwards one PTY resize because the proposed
      // grid differs from the current 80×24.
      terminalState.proposedDimensions = { cols: 100, rows: 30 }
      act(() => {
        observer.callback([], observer as unknown as ResizeObserver)
        observer.callback([], observer as unknown as ResizeObserver)
        observer.callback([], observer as unknown as ResizeObserver)
      })
      // Nothing fires until the debounce window elapses.
      expect(terminalState.fitCalls).toBe(fitCallsAfterOpen)
      act(() => {
        vi.advanceTimersByTime(120)
      })
      expect(terminalState.fitCalls).toBe(fitCallsAfterOpen + 1)
      expect(paneState.connections[0].sendResize).toHaveBeenCalledTimes(2)

      // A real resize forces a clean repaint: clear the WebGL atlas and refresh,
      // so stale glyphs from the old grid don't smear at their pre-resize cells.
      expect(terminalState.clearTextureAtlasCalls).toBe(1)
      expect(terminalState.refreshCalls).toBe(1)

      // The observer stays live (never disconnects), so later resizes still fit.
      expect(observer.disconnect).not.toHaveBeenCalled()

      // A resize that leaves the character grid unchanged is a no-op: no fit,
      // no SIGWINCH-inducing PTY resize, so the Ink TUI never redraws. (The
      // mock Terminal keeps its 80×24 grid, so proposing 80×24 means "no
      // change" regardless of the fit above.)
      terminalState.proposedDimensions = { cols: 80, rows: 24 }
      act(() => {
        observer.callback([], observer as unknown as ResizeObserver)
        vi.advanceTimersByTime(120)
      })
      expect(terminalState.fitCalls).toBe(fitCallsAfterOpen + 1)
      expect(paneState.connections[0].sendResize).toHaveBeenCalledTimes(2)
      expect(terminalState.clearTextureAtlasCalls).toBe(1)
      expect(terminalState.refreshCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
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

  it('defers opening the agent pane (and the WebGL renderer) until the container has dimensions', async () => {
    // The agent pane mounts inside a `hidden` (display:none) tab, so at mount
    // the container reports 0×0. Opening — and especially constructing the
    // WebGL texture atlas — against a 0-size element corrupts glyph rendering
    // (smeared, overlapping text). Nothing should open until the pane is
    // actually measured.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 0 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 0 })

    await act(async () => {
      root.render(<PaneTerminal runId="r1" paneId="agent" />)
    })

    // Renderer is dormant: no open(), no WebGL context, no fit.
    expect(terminalState.openCalls).toBe(0)
    expect(terminalState.webglAddonCtorCalls).toBe(0)
    expect(terminalState.fitCalls).toBe(0)
    // ...but the PTY socket connects immediately so buffered output isn't lost.
    expect(paneState.connections).toHaveLength(1)

    // Container gets real layout; the (debounced) resize observer fires.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 })
    vi.useFakeTimers()
    try {
      act(() => {
        const observer = resizeState.observers[0]
        observer.callback([], observer as unknown as ResizeObserver)
        vi.advanceTimersByTime(120)
      })
    } finally {
      vi.useRealTimers()
    }

    // Now it opens exactly once, WebGL initializes against the real size, and
    // the grid is fit.
    expect(terminalState.openCalls).toBe(1)
    expect(terminalState.webglAddonCtorCalls).toBe(1)
    expect(terminalState.fitCalls).toBeGreaterThanOrEqual(1)
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
