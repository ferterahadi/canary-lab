import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { connectPane, type PaneConnection } from '../api/pane-socket'
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
}

// Renders a single xterm.js terminal bound to one pane. Re-mounts when
// runId/paneId change. Buffer replay is handled server-side, so a fresh
// Terminal per mount is fine.
export function PaneTerminal({ runId, paneId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const noticeKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    noticeKeysRef.current = new Set()
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
      onExit: (code) => term.writeln(`\r\nPane exited code=${code}`),
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
