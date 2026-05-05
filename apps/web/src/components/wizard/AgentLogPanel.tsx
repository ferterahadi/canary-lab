import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { connectDraftAgent } from '../../api/draft-socket'
import { currentResolvedTheme, subscribeTheme, type ResolvedTheme } from '../../lib/theme'
import { appendCleanTerminalText, stripTerminalControls } from '../../lib/terminal-text'

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
  draftId: string
  // Optional initial buffer (e.g. the tail captured by the REST endpoint
  // before the WS connection completes). Appended above the live stream.
  initialBuffer?: string
  agent?: 'claude' | 'codex'
  phase?: 'planning' | 'generating' | 'refining'
  status?: 'running' | 'failed' | 'idle'
  compact?: boolean
}

// Terminal-like live stream for wizard agent stdout. The underlying agent runs
// in a PTY, but this panel only renders cleaned text so control sequences never
// leak into labels or copyable output.
export function AgentLogPanel({ draftId, initialBuffer, agent, phase, status = 'running', compact = false }: Props) {
  const [text, setText] = useState(stripTerminalControls(initialBuffer ?? ''))
  const [expanded, setExpanded] = useState(!compact)
  const terminalRef = useRef<Terminal | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef(text)

  useEffect(() => {
    const clean = stripTerminalControls(initialBuffer ?? '')
    textRef.current = clean
    setText(clean)
    terminalRef.current?.reset()
    terminalRef.current?.write(clean || 'Waiting for agent output...')
  }, [initialBuffer])

  useEffect(() => {
    let cancelled = false
    const conn = connectDraftAgent({
      draftId,
      onData: (chunk) => {
        if (cancelled) return
        const cleanChunk = stripTerminalControls(chunk)
        const hadText = textRef.current.trim().length > 0
        setText((prev) => {
          const next = appendCleanTerminalText(prev, cleanChunk)
          textRef.current = next
          return next
        })
        if (!hadText && terminalRef.current) terminalRef.current.reset()
        terminalRef.current?.write(cleanChunk)
      },
    })
    return () => {
      cancelled = true
      conn.close()
    }
  }, [draftId])

  useEffect(() => {
    if (!expanded) return
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      convertEol: true,
      cursorBlink: status === 'running',
      disableStdin: true,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11,
      theme: TERM_THEMES[currentResolvedTheme()],
    })
    terminalRef.current = term
    const unsubscribeTheme = subscribeTheme((next) => {
      term.options.theme = TERM_THEMES[next]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    term.write(textRef.current || 'Waiting for agent output...')
    try { fit.fit() } catch { /* container not measured yet */ }
    const handleResize = (): void => { try { fit.fit() } catch { /* ignore */ } }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      unsubscribeTheme()
      terminalRef.current = null
      term.dispose()
    }
  }, [draftId, expanded, status])

  const lines = text.trim().split('\n').map((line) => line.trimEnd()).filter(Boolean)
  const tailLines = lines.length > 0 ? lines.slice(-5) : ['Waiting for agent output...']
  const phaseLabel = phase === 'planning'
    ? 'Plan generation'
    : phase === 'generating'
      ? 'Spec generation'
      : phase === 'refining'
        ? 'Draft refinement'
        : 'Agent output'

  return (
    <div className="rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        {status === 'running' && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
        {status === 'failed' && <span className="h-2 w-2 rounded-full bg-rose-500" />}
        {status === 'idle' && <span className="h-2 w-2 rounded-full bg-zinc-400" />}
        <span className="font-medium text-zinc-800 dark:text-zinc-200">{phaseLabel}</span>
        {agent && <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-500 dark:bg-zinc-900">{agent}</span>}
        <span className="min-w-0 flex-1" />
        {compact && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            {expanded ? 'Show less' : 'Full output'}
          </button>
        )}
      </div>
      {!expanded && (
        <pre className="max-h-24 overflow-hidden border-b border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-[11px] leading-5 text-zinc-600 whitespace-pre-wrap dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          {tailLines.join('\n')}
        </pre>
      )}
      {expanded && (
        <div
          ref={containerRef}
          className="h-64 overflow-hidden p-2"
          style={{ background: 'var(--bg-base)' }}
        />
      )}
    </div>
  )
}
