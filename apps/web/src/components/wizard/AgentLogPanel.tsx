import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getDraftAgentLog } from '../../api/client'
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
  phase?: 'planning' | 'generating'
  status?: 'running' | 'failed' | 'idle'
  variant?: 'fill' | 'bounded'
  className?: string
}

// Terminal-like live stream for wizard agent stdout. Keep a cleaned shadow
// buffer for readiness checks, but write raw chunks to xterm so formatter ANSI
// styling survives.
export function AgentLogPanel({ draftId, initialBuffer, agent, phase, status = 'running', variant, className = '' }: Props) {
  const terminalRef = useRef<Terminal | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef(stripTerminalControls(initialBuffer ?? ''))
  const rawTextRef = useRef(initialBuffer ?? '')
  const persistedLogRef = useRef('')
  const duplicateReplayRemainingRef = useRef(0)
  const statusRef = useRef(status)
  const followingLatestRef = useRef(true)
  const bufferedVisualChunksRef = useRef<string[]>([])
  const bufferedLineCountRef = useRef(0)
  const [bufferedLineCount, setBufferedLineCount] = useState(0)

  const clearBufferedVisualOutput = useCallback(() => {
    bufferedVisualChunksRef.current = []
    bufferedLineCountRef.current = 0
    setBufferedLineCount(0)
  }, [])

  const flushBufferedVisualOutput = useCallback((scrollToBottom = true) => {
    const term = terminalRef.current
    const chunks = bufferedVisualChunksRef.current
    if (!term || chunks.length === 0) return
    bufferedVisualChunksRef.current = []
    bufferedLineCountRef.current = 0
    setBufferedLineCount(0)
    term.write(chunks.join(''))
    if (scrollToBottom) term.scrollToBottom()
    followingLatestRef.current = true
  }, [])

  const resetTerminalOutput = useCallback((raw: string) => {
    clearBufferedVisualOutput()
    followingLatestRef.current = true
    const term = terminalRef.current
    if (!term) return
    term.reset()
    term.write(stripWizardSessionMarkers(raw) || 'Waiting for agent output...')
    term.scrollToBottom()
  }, [clearBufferedVisualOutput])

  const writeVisualChunk = useCallback((chunk: string) => {
    const text = stripWizardSessionMarkers(chunk)
    if (!text) return
    const term = terminalRef.current
    if (!term) return
    if (statusRef.current === 'running' && !followingLatestRef.current) {
      bufferedVisualChunksRef.current.push(text)
      bufferedLineCountRef.current += countDisplayLines(text)
      setBufferedLineCount(bufferedLineCountRef.current)
      return
    }
    term.write(text)
  }, [])

  useEffect(() => {
    const raw = initialBuffer ?? ''
    const clean = stripTerminalControls(raw)
    rawTextRef.current = raw
    textRef.current = clean
    persistedLogRef.current = ''
    duplicateReplayRemainingRef.current = 0
    resetTerminalOutput(raw)
  }, [initialBuffer, resetTerminalOutput])

  useEffect(() => {
    let cancelled = false
    const stage = phase ?? 'planning'
    getDraftAgentLog(draftId, stage)
      .then(({ content }) => {
        if (cancelled) return
        persistedLogRef.current = content
        duplicateReplayRemainingRef.current = content.length
        rawTextRef.current = content
        textRef.current = stripTerminalControls(content)
        resetTerminalOutput(content)
      })
      .catch(() => {
        // The tail passed through the draft record remains the fallback for
        // drafts whose log file has not been created yet or older servers.
      })
    return () => { cancelled = true }
  }, [draftId, phase, resetTerminalOutput])

  useEffect(() => {
    let cancelled = false
    const conn = connectDraftAgent({
      draftId,
      stage: phase,
      onData: (chunk) => {
        if (cancelled) return
        if (shouldDropDuplicateReplay(chunk, persistedLogRef.current, duplicateReplayRemainingRef)) return
        const cleanChunk = stripTerminalControls(chunk)
        const hadText = textRef.current.trim().length > 0
        textRef.current = appendCleanTerminalText(textRef.current, cleanChunk)
        rawTextRef.current += chunk
        if (!hadText && terminalRef.current) {
          terminalRef.current.reset()
          followingLatestRef.current = true
        }
        writeVisualChunk(chunk)
      },
    })
    return () => {
      cancelled = true
      conn.close()
    }
  }, [draftId, phase, writeVisualChunk])

  useEffect(() => {
    statusRef.current = status
    if (status !== 'running') {
      clearBufferedVisualOutput()
      followingLatestRef.current = true
    }
  }, [clearBufferedVisualOutput, status])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      convertEol: true,
      cursorBlink: status === 'running',
      disableStdin: true,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11,
      scrollback: 100_000,
      theme: TERM_THEMES[currentResolvedTheme()],
    })
    terminalRef.current = term
    const unsubscribeTheme = subscribeTheme((next) => {
      term.options.theme = TERM_THEMES[next]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    term.write(stripWizardSessionMarkers(rawTextRef.current) || 'Waiting for agent output...')
    let frame: number | null = null
    const fitNow = (): void => { try { fit.fit() } catch { /* container not measured yet */ } }
    const scheduleFit = (): void => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        fitNow()
      })
    }
    scheduleFit()
    const scrollDisposable = term.onScroll(() => {
      if (statusRef.current !== 'running') return
      followingLatestRef.current = isAtTerminalBottom(term)
      if (followingLatestRef.current) flushBufferedVisualOutput(true)
    })
    const handleResize = (): void => { scheduleFit() }
    window.addEventListener('resize', handleResize)
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', handleResize)
      resizeObserver.disconnect()
      scrollDisposable.dispose()
      unsubscribeTheme()
      terminalRef.current = null
      term.dispose()
    }
  }, [draftId, flushBufferedVisualOutput, status])

  const phaseLabel = phase === 'planning'
    ? 'Plan generation'
    : phase === 'generating'
      ? 'Spec generation'
      : 'Agent output'
  const layoutVariant = variant ?? (status === 'running' ? 'fill' : 'bounded')
  const panelClassName = layoutVariant === 'fill'
    ? 'flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
    : 'flex min-h-0 max-h-[min(70vh,44rem)] flex-col overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
  const terminalClassName = layoutVariant === 'fill'
    ? 'min-h-0 flex-1 overflow-hidden p-2'
    : 'h-[min(52vh,34rem)] min-h-[18rem] flex-1 overflow-hidden p-2'

  return (
    <div className={`${panelClassName} ${className}`}>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        {status === 'running' && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
        {status === 'failed' && <span className="h-2 w-2 rounded-full bg-rose-500" />}
        {status === 'idle' && <span className="h-2 w-2 rounded-full bg-zinc-400" />}
        <span className="font-medium text-zinc-800 dark:text-zinc-200">{phaseLabel}</span>
        {agent && <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-500 dark:bg-zinc-900">{agent}</span>}
        <span className="min-w-0 flex-1" />
        {status === 'running' && bufferedLineCount === 0 && (
          <span className="inline-flex items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-500" />
            Running
          </span>
        )}
        {status === 'running' && bufferedLineCount > 0 && (
          <button
            type="button"
            onClick={() => flushBufferedVisualOutput(true)}
            className="rounded bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
          >
            {bufferedLineCount.toLocaleString('en-US')} new {bufferedLineCount === 1 ? 'line' : 'lines'} · Jump latest
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        className={terminalClassName}
        style={{ background: 'var(--bg-base)' }}
      />
    </div>
  )
}

function countDisplayLines(text: string): number {
  const lines = text.split('\n').filter((line) => line.length > 0)
  return Math.max(1, lines.length)
}

function isAtTerminalBottom(term: Terminal): boolean {
  const { active } = term.buffer
  return active.viewportY >= active.baseY - 1
}

function stripWizardSessionMarkers(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('[[canary-lab:wizard-session '))
    .join('\n')
}

function shouldDropDuplicateReplay(
  chunk: string,
  persistedLog: string,
  remainingRef: { current: number },
): boolean {
  if (!persistedLog || remainingRef.current <= 0 || !chunk) return false
  const searchStart = Math.max(0, persistedLog.length - remainingRef.current - chunk.length)
  const idx = persistedLog.indexOf(chunk, searchStart)
  if (idx === -1) {
    remainingRef.current = 0
    return false
  }
  remainingRef.current = Math.max(0, persistedLog.length - (idx + chunk.length))
  return true
}
