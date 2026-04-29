import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { connectPane, type PaneConnection } from '../api/pane-socket'

interface Props {
  runId: string
  paneId: string
}

// Renders a single xterm.js terminal bound to one pane. Re-mounts when
// runId/paneId change. Buffer replay is handled server-side, so a fresh
// Terminal per mount is fine.
export function PaneTerminal({ runId, paneId }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      theme: { background: '#09090b', foreground: '#e4e4e7' },
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
      conn.close()
      term.dispose()
    }
  }, [runId, paneId])

  return <div ref={containerRef} className="h-full w-full bg-zinc-950 p-2" />
}
