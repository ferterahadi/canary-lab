import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { connectPane, type PaneConnection } from '../api/pane-socket'
import { currentResolvedTheme, subscribeTheme, type ResolvedTheme } from '../lib/theme'

const TERM_THEMES: Record<ResolvedTheme, { background: string; foreground: string }> = {
  dark: { background: '#282c34', foreground: '#abb2bf' },
  light: { background: '#fafafa', foreground: '#383a42' },
}

interface Props {
  runId: string
  paneId: string
}

// Renders a single xterm.js terminal bound to one pane. Re-mounts when
// runId/paneId change. Buffer replay is handled server-side, so a fresh
// Terminal per mount is fine.
export function PaneTerminal({ runId, paneId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      convertEol: true,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      theme: TERM_THEMES[currentResolvedTheme()],
    })
    const unsubscribeTheme = subscribeTheme((next) => {
      term.options.theme = TERM_THEMES[next]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    try { fit.fit() } catch { /* container not measured yet */ }

    const conn: PaneConnection = connectPane({
      runId,
      paneId,
      onData: (chunk) => term.write(chunk),
      onExit: (code) => term.writeln(`\r\n[pane exited code=${code}]`),
      onError: (err) => term.writeln(`\r\n[error: ${err}]`),
    })

    const handleResize = (): void => { try { fit.fit() } catch { /* ignore */ } }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      unsubscribeTheme()
      conn.close()
      term.dispose()
    }
  }, [runId, paneId])

  return <div ref={containerRef} className="h-full w-full p-2" style={{ background: 'var(--bg-base)' }} />
}
