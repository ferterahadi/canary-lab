import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { connectPane, type PaneConnection } from '../api/pane-socket'
import * as api from '../api/client'
import { currentResolvedTheme, subscribeTheme, type ResolvedTheme } from '../lib/theme'
import { paneTerminalNotice } from '../lib/pane-terminal-message'

const TERM_THEMES: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: '#0d1117',
    foreground: '#d7e1ea',
    selectionBackground: '#164a63',
    selectionForeground: '#ffffff',
    selectionInactiveBackground: '#1d3344',
  },
  light: {
    background: '#f4f7fb',
    foreground: '#17202a',
    selectionBackground: '#b9e2f5',
    selectionForeground: '#17202a',
    selectionInactiveBackground: '#d9edf7',
  },
}

interface Props {
  runId: string
  paneId: string
  onExit?: (code: number) => void
}

// Renders a single xterm.js terminal bound to one pane. Re-mounts when
// runId/paneId change. Buffer replay is handled server-side, so a fresh
// Terminal per mount is fine.
export function PaneTerminal({ runId, paneId, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const noticeKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const isAgentPane = paneId === 'agent'
    noticeKeysRef.current = new Set()
    const term = new Terminal({
      convertEol: true,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      scrollback: 20000,
      theme: TERM_THEMES[currentResolvedTheme()],
    })
    const unsubscribeTheme = subscribeTheme((next) => {
      term.options.theme = TERM_THEMES[next]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

    // Use the WebGL renderer on the agent pane. Codex and Claude TUIs (Ink)
    // emit full-screen ANSI redraws on every keystroke and every generated
    // token — dozens per second. The default DOM renderer repaints one node
    // per cell and visibly flickers under that load; WebGL paints via a
    // single batched canvas. Falls back silently to DOM if the context can't
    // be created (headless env, no GPU) or is later lost.
    let webgl: WebglAddon | null = null
    if (isAgentPane) {
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          addon.dispose()
          webgl = null
        })
        term.loadAddon(addon)
        webgl = addon
      } catch {
        webgl = null
      }
    }

    const fitOnce = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try { fit.fit() } catch { /* ignore */ }
    }

    fitOnce()

    const conn: PaneConnection = connectPane({
      runId,
      paneId,
      onData: (chunk) => {
        term.write(chunk)
      },
      onExit: (code) => {
        term.writeln(`\r\nPane exited code=${code}`)
        onExit?.(code)
      },
      onReset: () => {
        // Server reset the pane (e.g. Restart Heal kicked off a fresh
        // orchestrator). Wipe the visible xterm so the new REPL streams
        // into a clean canvas. Notice keys are also reset so a re-emitted
        // error after restart isn't suppressed.
        term.clear()
        noticeKeysRef.current = new Set()
      },
      onError: (err) => {
        const notice = paneTerminalNotice(paneId, err)
        if (noticeKeysRef.current.has(notice.key)) return
        noticeKeysRef.current.add(notice.key)
        const [title, ...details] = notice.lines
        term.writeln(`\r\n${title}`)
        for (const detail of details) {
          term.writeln(`\x1b[2m${detail}\x1b[22m`)
        }
      },
      onOpen: () => {
        conn.sendResize(term.cols, term.rows)
      },
    })

    // Intercept Ctrl+C on the agent pane and route it to the cancel-heal
    // API instead of letting it through as a raw \x03 to the agent process.
    // The user's mental model: Ctrl+C = "stop this heal". Without this,
    // Ctrl+C would only interrupt the current generation but the orchestrator would
    // immediately re-prompt on the next cycle. 404 / 409 from the API are
    // ignored — if there's nothing to cancel, the keystroke is a no-op.
    const keyHandler = (e: KeyboardEvent): boolean => {
      if (paneId !== 'agent') return true
      if (e.type !== 'keydown') return true
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return true
      const isC = e.key === 'c' || e.key === 'C' || e.code === 'KeyC'
      if (!isC) return true
      api.cancelHealRun(runId).catch(() => { /* nothing to cancel — no-op */ })
      return false
    }
    term.attachCustomKeyEventHandler(keyHandler)

    // Forward keystrokes to the server-side pty. Only the `agent` pane has a
    // live REPL on the other end; other panes ignore input server-side, so
    // wiring it unconditionally is harmless and keeps the component simple.
    const inputDisposable = term.onData((data) => conn.sendInput(data))

    // Re-fit non-agent panes on container resize. Two cases matter:
    // 1. Initial mount after a tab switch — the inline fit.fit() above can
    //    silently fail because the container has 0 dims before layout
    //    settles. The observer fires once the container is measured, so xterm
    //    catches up to the real pane size and forwards one stable PTY resize.
    // 2. Later in-app resizes — splitter drag, sidebar toggle, etc. The
    //    old window 'resize' listener missed these.
    //
    // The heal-agent pane is intentionally excluded. Codex and Claude render
    // full-screen TUIs that redraw on SIGWINCH; live ResizeObserver fitting can
    // loop with xterm's own DOM changes and make the prompt blink while typing.
    let observer: ResizeObserver | null = null
    if (!isAgentPane && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        fitOnce()
      })
      observer.observe(container)
    }
    return () => {
      observer?.disconnect()
      unsubscribeTheme()
      inputDisposable.dispose()
      conn.close()
      webgl?.dispose()
      term.dispose()
    }
  }, [runId, paneId, onExit])

  return <div ref={containerRef} className="h-full w-full p-2" style={{ background: 'var(--bg-base)' }} />
}
