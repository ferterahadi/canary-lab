import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTheme } from '../../lib/theme'
import type { ExtractedStep } from '../../api/types'
import * as api from '../../api/client'
import { sourceLineForBodyLine } from '../../lib/editor-location'
import { colorClassForStatus, statusLabel, statusPillClassForStatus, type StepStatus } from '../../lib/test-step-status'

type Highlighter = { codeToHtml: (code: string, opts: { lang: string; theme: string }) => string }
let highlighterPromise: Promise<Highlighter> | null = null
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }, ts, dark, light, wasm] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/themes/one-dark-pro.mjs'),
        import('shiki/themes/one-light.mjs'),
        import('shiki/wasm'),
      ])
      const hl = await createHighlighterCore({
        themes: [dark.default, light.default],
        langs: [ts.default],
        engine: createOnigurumaEngine(wasm.default),
      })
      return {
        codeToHtml: (code, opts) => hl.codeToHtml(code, opts),
      }
    })()
  }
  return highlighterPromise
}

interface SourceLocation {
  file: string
  startLine: number
}

// Renders syntax-highlighted code using Shiki. The `source` prop comes from
// the feature's own spec files (server-side AST extraction), not untrusted
// user input, so innerHTML is safe here.
export function ShikiCode({
  source,
  activeLine,
  sourceLocation,
  runningHighlight,
}: {
  source: string
  activeLine?: number | null
  sourceLocation?: SourceLocation
  runningHighlight?: boolean
}) {
  const { resolved } = useTheme()
  const [html, setHtml] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const themeName = resolved === 'dark' ? 'one-dark-pro' : 'one-light'
    getHighlighter().then((hl) => {
      if (cancelled) return
      try {
        setHtml(hl.codeToHtml(source, { lang: 'typescript', theme: themeName }))
      } catch {
        setHtml(null)
      }
    }).catch(() => { if (!cancelled) setHtml(null) })
    return () => { cancelled = true }
  }, [source, resolved])

  const openAt = async (line: number): Promise<void> => {
    if (!sourceLocation) return
    setOpenError(null)
    try {
      await api.openEditor({ file: sourceLocation.file, line, column: 1 })
    } catch (e: unknown) {
      setOpenError(e instanceof Error ? e.message : 'Failed to open editor')
    }
  }

  if (html === null) {
    return (
      <CodeShell sourceLocation={sourceLocation} openError={openError} onOpenStart={() => openAt(sourceLocation?.startLine ?? 1)}>
        <pre className="cl-code-shell overflow-hidden whitespace-pre-wrap break-words rounded-md p-2 text-[11px]" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
          <code>{source}</code>
        </pre>
      </CodeShell>
    )
  }

  return (
    <CodeShell sourceLocation={sourceLocation} openError={openError} onOpenStart={() => openAt(sourceLocation?.startLine ?? 1)}>
      <div
        className={`shiki-block cl-code-shell overflow-hidden rounded-md text-[11px] ${sourceLocation ? '[&_span.line]:cursor-pointer [&_span.line:hover]:bg-sky-500/10' : ''}`}
        onClick={(e) => {
          const line = (e.target as HTMLElement).closest<HTMLElement>('[data-source-line]')?.dataset.sourceLine
          if (line) void openAt(Number(line))
        }}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: decorateShikiLines(html, activeLine, sourceLocation?.startLine, runningHighlight) }}
      />
    </CodeShell>
  )
}

function CodeShell({
  children,
  sourceLocation,
  openError,
  onOpenStart,
}: {
  children: ReactNode
  sourceLocation?: SourceLocation
  openError: string | null
  onOpenStart: () => void
}) {
  if (!sourceLocation) return <>{children}</>
  return (
    <div className="space-y-1">
      <div className="relative">
        <button
          type="button"
          title="Open in editor"
          aria-label="Open in editor"
          onClick={onOpenStart}
          className="cl-icon-button absolute right-1 top-1 z-10 h-6 w-6 text-[12px]"
          style={{
            border: '1px solid var(--border-default)',
            background: 'color-mix(in srgb, var(--bg-surface) 92%, transparent)',
            boxShadow: 'var(--shadow-panel)',
          }}
        >
          ↗
        </button>
        {children}
      </div>
      {openError && (
        <div className="text-[10px]" style={{ color: 'var(--danger)' }}>
          {openError}
        </div>
      )}
    </div>
  )
}

function decorateShikiLines(html: string, activeLine?: number | null, startLine?: number, runningHighlight?: boolean): string {
  let lineNo = 0
  const bg = runningHighlight ? 'rgba(234, 179, 8, 0.22)' : 'rgba(14, 165, 233, 0.18)'
  const bar = runningHighlight ? 'rgb(234, 179, 8)' : 'rgb(14, 165, 233)'
  return html.replace(/<span class="line"/g, (match) => {
    lineNo += 1
    const attrs = startLine ? ` data-source-line="${sourceLineForBodyLine(startLine, lineNo)}"` : ''
    if (lineNo !== activeLine) return `${match}${attrs}`
    return `<span class="line"${attrs} data-active-line="true" style="display:block;margin:0 -0.5rem;padding:0 0.5rem;background:${bg};box-shadow:inset 2px 0 0 ${bar}"`
  })
}

export function StatusPill({ status }: { status: StepStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${statusPillClassForStatus(status)}`}
      style={{ fontFamily: 'var(--font-mono)', minWidth: '3.5rem' }}
    >
      {statusLabel(status)}
    </span>
  )
}

export function StepBlock({
  step,
  status,
  depth,
  sourceFile,
  runningSourceLine,
}: {
  step: ExtractedStep
  status: StepStatus
  depth: number
  sourceFile?: string
  runningSourceLine?: number | null
}) {
  const [expanded, setExpanded] = useState(false)
  const activeLine = bodyLineForSourceLine(step.line, step.bodySource, runningSourceLine)
  const isRunningStep = activeLine != null
  const cardClass = isRunningStep
    ? 'border-yellow-500/60 bg-yellow-400/15 dark:border-yellow-400/60 dark:bg-yellow-400/10'
    : `${colorClassForStatus(status)} bg-[var(--bg-surface)]`
  return (
    <li
      className={`rounded-md border ${cardClass} p-1.5`}
      style={isRunningStep ? { boxShadow: 'inset 3px 0 0 rgb(234, 179, 8)' } : undefined}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs"
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ color: 'var(--text-muted)' }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ color: 'var(--text-primary)' }}>{step.label}</span>
        <span className="ml-auto text-[10px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>L{step.line}</span>
      </button>
      {expanded && step.bodySource && (
        <div className="mt-1.5">
          <ShikiCode
            source={step.bodySource}
            activeLine={activeLine}
            sourceLocation={sourceFile ? { file: sourceFile, startLine: step.line } : undefined}
            runningHighlight={isRunningStep}
          />
        </div>
      )}
      {step.children.length > 0 && (
        <ul className="mt-1.5 space-y-1.5 pl-3" style={{ borderLeft: '1px solid var(--border-default)' }}>
          {step.children.map((child, i) => (
            <StepBlock key={`${child.line}:${i}`} step={child} status={status} depth={depth + 1} sourceFile={sourceFile} runningSourceLine={runningSourceLine} />
          ))}
        </ul>
      )}
    </li>
  )
}

function bodyLineForSourceLine(startLine: number, source: string, sourceLine?: number | null): number | null {
  if (sourceLine == null) return null
  if (!source) return null
  const line = sourceLine - startLine + 1
  if (line < 1 || line > source.split('\n').length) return null
  return line
}
