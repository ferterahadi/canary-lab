import { useEffect, useRef, useState } from 'react'
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
  /**
   * Placeholder shown over the terminal while it has streamed no output yet —
   * so an idle pane reads as "nothing here yet" instead of a blank black box.
   * Omit it (e.g. the heal-agent pane) to keep the bare terminal.
   */
  emptyState?: { title: string; hint?: string }
}

// How long to wait after mount before showing the empty-state placeholder.
// The pane socket replays any buffered output on connect, so a pane that DOES
// have logs fills in within a few frames — this grace window keeps the
// placeholder from flashing before that replayed output lands.
const EMPTY_STATE_GRACE_MS = 600

// Renders a single xterm.js terminal bound to one pane. Re-mounts when
// runId/paneId change. Buffer replay is handled server-side, so a fresh
// Terminal per mount is fine.
export function PaneTerminal({ runId, paneId, onExit, emptyState }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const noticeKeysRef = useRef<Set<string>>(new Set())
  const hadOutputRef = useRef(false)
  // `hasOutput` flips true on the first streamed byte (or exit/error notice);
  // `graceElapsed` gates the placeholder so it only appears once we've waited
  // long enough to be confident the pane really is empty. Both reset on a
  // pane reset (Restart Heal) so a freshly-cleared pane shows the placeholder
  // again until new output arrives.
  const [hasOutput, setHasOutput] = useState(false)
  const [graceElapsed, setGraceElapsed] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const isAgentPane = paneId === 'agent'
    noticeKeysRef.current = new Set()
    hadOutputRef.current = false
    setHasOutput(false)
    setGraceElapsed(false)
    const graceTimer = setTimeout(() => setGraceElapsed(true), EMPTY_STATE_GRACE_MS)
    // Flip to "has output" exactly once, on the false→true transition, so a
    // chatty pane (the Ink heal-agent TUI emits dozens of frames/sec) doesn't
    // dispatch a state update per chunk.
    const markOutput = (): void => {
      if (hadOutputRef.current) return
      hadOutputRef.current = true
      setHasOutput(true)
    }
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
        if (chunk) markOutput()
        term.write(chunk)
      },
      onExit: (code) => {
        markOutput()
        term.writeln(`\r\nPane exited code=${code}`)
        onExit?.(code)
      },
      onReset: () => {
        // Server reset the pane (e.g. Restart Heal kicked off a fresh
        // orchestrator). Wipe the visible xterm so the new REPL streams
        // into a clean canvas. Notice keys are also reset so a re-emitted
        // error after restart isn't suppressed, and the empty-state
        // placeholder returns until the fresh REPL prints something.
        term.clear()
        noticeKeysRef.current = new Set()
        hadOutputRef.current = false
        setHasOutput(false)
      },
      onError: (err) => {
        const notice = paneTerminalNotice(paneId, err)
        if (noticeKeysRef.current.has(notice.key)) return
        noticeKeysRef.current.add(notice.key)
        markOutput()
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
    if (typeof ResizeObserver !== 'undefined') {
      if (isAgentPane) {
        // One-shot fit on the agent pane. PaneTerminal now stays mounted
        // across tab switches (hidden via the parent's `hidden` attribute),
        // so on first mount the container is 0×0 and the inline fitOnce()
        // above short-circuits; onOpen then forwards the default 80×24 to
        // the pty. Observe until the container reports real dims, fit once,
        // push the new size to the pty, then disconnect — we don't keep
        // observing because the Ink TUI redraws on every SIGWINCH and a
        // live observer would loop with xterm's own DOM mutations, flickering
        // the prompt while typing.
        observer = new ResizeObserver(() => {
          if (container.clientWidth === 0 || container.clientHeight === 0) return
          fitOnce()
          conn.sendResize(term.cols, term.rows)
          observer?.disconnect()
          observer = null
        })
      } else {
        observer = new ResizeObserver(() => {
          fitOnce()
        })
      }
      observer.observe(container)
    }
    return () => {
      clearTimeout(graceTimer)
      observer?.disconnect()
      unsubscribeTheme()
      inputDisposable.dispose()
      conn.close()
      webgl?.dispose()
      term.dispose()
    }
  }, [runId, paneId, onExit])

  const showEmptyState = Boolean(emptyState) && !hasOutput && graceElapsed

  return (
    <div className="relative h-full w-full" style={{ background: 'var(--bg-base)' }}>
      <div ref={containerRef} className="h-full w-full p-2" />
      {showEmptyState && emptyState && (
        <PaneEmptyState title={emptyState.title} hint={emptyState.hint} />
      )}
    </div>
  )
}

// Centered placeholder layered over the (empty) terminal. `pointer-events-none`
// keeps the xterm underneath fully interactive — the moment output streams in,
// `showEmptyState` flips false and this unmounts.
function PaneEmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex select-none flex-col items-center justify-center gap-2.5 px-6 text-center">
      <span style={{ color: 'var(--text-muted)', opacity: 0.55 }}>
        <TerminalGlyph />
      </span>
      <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </div>
      {hint && (
        <div className="max-w-[280px] text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  )
}

function TerminalGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  )
}
