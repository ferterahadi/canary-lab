import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { connectPane, type PaneConnection } from '../api/pane-socket'
import * as api from '../../../api/client'
import { currentResolvedTheme, subscribeTheme, type ResolvedTheme } from '../../../lib/theme'
import { paneTerminalNotice } from '../utils/pane-terminal-message'

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

    // Renderer lifecycle. `term.open()` and the WebGL atlas are deferred until
    // the container actually has layout (see openTerminal). The PTY socket
    // below connects immediately regardless — xterm buffers writes before
    // open(), so streamed output isn't lost while we wait to be measured.
    let webgl: WebglAddon | null = null
    let opened = false
    let disposed = false
    let conn: PaneConnection | null = null

    const fitOnce = (): void => {
      if (!opened) return
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try { fit.fit() } catch { /* ignore */ }
    }

    // Open the renderer exactly once, and only after the container has non-zero
    // dimensions. The agent pane mounts inside a `hidden` (display:none) tab and
    // the benchmark window animates open, so at mount the container is 0×0.
    // Opening — and especially constructing the WebGL texture atlas — against a
    // 0-size element bakes in the wrong canvas backing store and DPR scaling,
    // which renders as smeared, overlapping glyphs that a later
    // clearTextureAtlas() can't recover. Returns true the first time it opens.
    const openTerminal = (): boolean => {
      if (opened || disposed) return false
      if (container.clientWidth === 0 || container.clientHeight === 0) return false
      term.open(container)
      // Use the WebGL renderer on the agent pane. Codex and Claude TUIs (Ink)
      // emit full-screen ANSI redraws on every keystroke and every generated
      // token — dozens per second. The default DOM renderer repaints one node
      // per cell and visibly flickers under that load; WebGL paints via a
      // single batched canvas. Falls back silently to DOM if the context can't
      // be created (headless env, no GPU) or is later lost.
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
      opened = true
      fitOnce()
      // The socket may already be open with output buffered into the pre-open
      // terminal; sync the PTY to the grid we just measured.
      conn?.sendResize(term.cols, term.rows)
      return true
    }

    // FitAddon derives cols/rows from the measured character-cell width. The
    // mono font (JetBrains Mono) loads from Google Fonts with `display=swap`,
    // so the FIRST fit can measure the fallback font's cell width and compute a
    // column count that doesn't match the real glyphs once the font swaps in.
    // The wrong cols is then sent to the pty, and the Ink TUI (which wraps to
    // whatever width it's told) renders lines that overflow the pane — trailing
    // characters pile into the last column and continuations spill to the left.
    // Re-fit once the real font is loaded, re-send the corrected size to the
    // pty, and repaint the (now-stale) WebGL atlas. Guarded for environments
    // without the Font Loading API (e.g. the happy-dom test runner).
    const refitForFont = (): void => {
      if (disposed || !opened) return
      fitOnce()
      conn?.sendResize(term.cols, term.rows)
      webgl?.clearTextureAtlas()
      term.refresh(0, term.rows - 1)
    }
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (fonts && typeof fonts.ready?.then === 'function') {
      // Explicitly kick the load (don't rely on `ready` alone — it only awaits
      // fonts already in the loading set) at both weights xterm may use, then
      // correct the grid. `ready` is the backstop for any remaining load.
      const loads = typeof fonts.load === 'function'
        ? [fonts.load('400 12px "JetBrains Mono"'), fonts.load('500 12px "JetBrains Mono"')]
        : []
      Promise.all([fonts.ready, ...loads]).then(refitForFont).catch(() => { /* ignore */ })
    }

    openTerminal()

    conn = connectPane({
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
        conn?.sendResize(term.cols, term.rows)
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
    const inputDisposable = term.onData((data) => conn?.sendInput(data))

    // Re-fit panes on container resize. Two cases matter:
    // 1. Initial mount after a tab switch — the inline fit.fit() above can
    //    silently fail because the container has 0 dims before layout
    //    settles. The observer fires once the container is measured, so xterm
    //    catches up to the real pane size and forwards one stable PTY resize.
    // 2. Later in-app resizes — splitter drag, sidebar toggle, etc. The
    //    old window 'resize' listener missed these.
    let observer: ResizeObserver | null = null
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    if (typeof ResizeObserver !== 'undefined') {
      if (isAgentPane) {
        // The agent pane runs an Ink TUI (Claude/Codex) that redraws the whole
        // screen on every SIGWINCH. A naive live observer that fit + resized on
        // each fire would spam SIGWINCH during a splitter drag and make the
        // prompt blink while typing — which is why this used to fit once and
        // then disconnect, leaving the pane frozen at its first-measured size.
        //
        // Instead, keep observing but guard the two flicker sources:
        //   • Debounce so a continuous drag collapses into a single fit at the
        //     end, not one per animation frame.
        //   • Only forward a PTY resize when the character grid actually
        //     changes (proposeDimensions vs current cols/rows). Typing and
        //     token streaming never change the grid, so they never trigger a
        //     SIGWINCH redraw — only real geometry changes do.
        const refitAgent = (): void => {
          if (container.clientWidth === 0 || container.clientHeight === 0) return
          // First measured fire after mounting hidden: open now (openTerminal
          // fits and forwards the resize itself), nothing more to do this pass.
          if (openTerminal()) return
          const proposed = fit.proposeDimensions()
          if (!proposed) return
          if (proposed.cols === term.cols && proposed.rows === term.rows) return
          fitOnce()
          conn?.sendResize(term.cols, term.rows)
          // The WebGL renderer keeps a texture atlas and per-cell geometry that
          // can desync from the new grid after a resize (most visibly across
          // Retina DPR), leaving stale glyphs smeared at their pre-resize
          // positions — and because the buffer is already correct, the Ink
          // TUI's own redraws never overwrite the bad paint. Clear the atlas
          // and force a full repaint so xterm draws the new grid from scratch.
          webgl?.clearTextureAtlas()
          term.refresh(0, term.rows - 1)
        }
        observer = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(refitAgent, 120)
        })
      } else {
        observer = new ResizeObserver(() => {
          // Open on the first measured fire (covers mounting in a hidden tab),
          // then plain re-fit on later resizes.
          if (!openTerminal()) fitOnce()
        })
      }
      observer.observe(container)
    }
    return () => {
      disposed = true
      clearTimeout(graceTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      observer?.disconnect()
      unsubscribeTheme()
      inputDisposable.dispose()
      conn?.close()
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
