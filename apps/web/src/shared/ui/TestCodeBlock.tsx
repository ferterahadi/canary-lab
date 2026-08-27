import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTheme } from '../lib/theme'
import type { ExtractedStep } from '../api/types'
import * as api from '../api/client'
import { getCodeHighlighter, codeThemeFor } from './code-highlighter'
import type { StoryCodeLineNumber } from './readable-story-sequence'
import {
  colorClassForStatus,
  sourceLineForBodyLine,
  statusLabel,
  statusPillClassForStatus,
  type StepStatus,
} from '@/features/runs'

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
  changedLines,
  showOpenButton = true,
  selectedSourceRange,
  storyLineNumbers,
}: {
  source: string
  activeLine?: number | null
  sourceLocation?: SourceLocation
  runningHighlight?: boolean
  showOpenButton?: boolean
  selectedSourceRange?: { startLine: number; endLine: number }
  /** Absolute source line to the corresponding English story number. When
   * present, continuation and structural source rows intentionally stay blank. */
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>
  /** 1-indexed body-relative line numbers (same convention as `activeLine`) to
   *  tint as changed — the diff-against-HEAD cue for a dirty test's body. Takes
   *  visual precedence over `activeLine`; the two aren't expected to co-occur
   *  (one's for a live-running test, the other for a completed dirty one). */
  changedLines?: Set<number>
}) {
  const { resolved } = useTheme()
  const [html, setHtml] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const themeName = codeThemeFor(resolved)
    getCodeHighlighter().then((hl) => {
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
      <CodeShell sourceLocation={sourceLocation} openError={openError} onOpenStart={() => openAt(sourceLocation?.startLine ?? 1)} showOpenButton={showOpenButton}>
        <pre className="cl-numbered-code cl-code-shell overflow-x-auto overflow-y-hidden whitespace-pre break-normal rounded-md p-2 text-[11px] leading-[1.65]" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
          <code>
            {source.split('\n').map((line, index) => (
              <FallbackCodeLine
                key={index}
                line={line}
                lineNumber={index + 1}
                startLine={sourceLocation?.startLine}
                storyLineNumbers={storyLineNumbers}
              />
            ))}
          </code>
        </pre>
      </CodeShell>
    )
  }

  return (
    <CodeShell sourceLocation={sourceLocation} openError={openError} onOpenStart={() => openAt(sourceLocation?.startLine ?? 1)} showOpenButton={showOpenButton}>
      <div
        className={`shiki-block cl-numbered-code cl-code-shell overflow-x-auto overflow-y-hidden rounded-md text-[11px] leading-[1.65] ${sourceLocation ? '[&_span.line]:cursor-pointer [&_span.line:hover]:bg-running/10' : ''}`}
        onClick={(e) => {
          const line = (e.target as HTMLElement).closest<HTMLElement>('[data-source-line]')?.dataset.sourceLine
          if (line) void openAt(Number(line))
        }}
        // Shiki has already escaped the source it highlighted; decorateShikiLines
        // only wraps those tokens in spans.
        // eslint-disable-next-line no-restricted-syntax
        dangerouslySetInnerHTML={{ __html: decorateShikiLines(html, activeLine, sourceLocation?.startLine, runningHighlight, changedLines, selectedSourceRange, storyLineNumbers) }}
      />
    </CodeShell>
  )
}

function FallbackCodeLine({
  line,
  lineNumber,
  startLine,
  storyLineNumbers,
}: {
  line: string
  lineNumber: number
  startLine?: number
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>
}) {
  const number = codeLineNumber(lineNumber, startLine, storyLineNumbers)
  return (
    <span
      className="line"
      data-code-line={number.physical}
      data-code-sequence={number.sequence}
      data-code-sequence-label={number.label}
      title={number.title}
    >
      {line}
    </span>
  )
}

function CodeShell({
  children,
  sourceLocation,
  openError,
  onOpenStart,
  showOpenButton,
}: {
  children: ReactNode
  sourceLocation?: SourceLocation
  openError: string | null
  onOpenStart: () => void
  showOpenButton: boolean
}) {
  if (!sourceLocation) return <>{children}</>
  return (
    <div className="space-y-1">
      <div className="relative">
        {showOpenButton && (
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
        )}
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

function decorateShikiLines(
  html: string,
  activeLine?: number | null,
  startLine?: number,
  runningHighlight?: boolean,
  changedLines?: Set<number>,
  selectedSourceRange?: { startLine: number; endLine: number },
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>,
): string {
  let lineNo = 0
  const bg = runningHighlight
    ? 'color-mix(in srgb, var(--warning) 22%, transparent)'
    : 'color-mix(in srgb, var(--running) 18%, transparent)'
  const bar = runningHighlight ? 'var(--warning)' : 'var(--running)'
  // Lines render as full-width blocks (`.shiki-block pre span.line`), so the
  // newline text nodes Shiki leaves between them must go — under pre-wrap each
  // would paint an extra blank row.
  return html.replace(/\n(?=<span class="line")/g, '').replace(/<span class="line"/g, (match) => {
    lineNo += 1
    const sourceLine = startLine ? sourceLineForBodyLine(startLine, lineNo) : null
    const number = codeLineNumber(lineNo, startLine, storyLineNumbers)
    const selected = sourceLine != null && selectedSourceRange != null &&
      sourceLine >= selectedSourceRange.startLine && sourceLine <= selectedSourceRange.endLine
    const attrs = ` data-code-line="${number.physical}" data-code-sequence="${number.sequence}" data-code-sequence-label="${number.label}"${number.title ? ` title="${number.title}"` : ''}${sourceLine ? ` data-source-line="${sourceLine}"` : ''}${selected ? ' data-selected-line="true"' : ''}`
    if (changedLines?.has(lineNo)) {
      return `<span class="line"${attrs} data-changed-line="true" style="background:color-mix(in srgb, var(--danger) 16%, transparent);box-shadow:inset 2px 0 0 var(--danger)"`
    }
    if (lineNo === activeLine) {
      return `<span class="line"${attrs} data-active-line="true" style="background:${bg};box-shadow:inset 2px 0 0 ${bar}"`
    }
    if (selected) {
      return `<span class="line"${attrs} style="background:color-mix(in srgb, var(--accent) 14%, transparent);box-shadow:inset 2px 0 0 var(--accent)"`
    }
    return `${match}${attrs}`
  })
}

function codeLineNumber(
  lineNumber: number,
  startLine?: number,
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>,
): {
  physical: string
  sequence: string
  label: string
  title?: string
} {
  const physical = String(lineNumber).padStart(2, '0')
  if (!storyLineNumbers || startLine === undefined) {
    return { physical, sequence: physical, label: physical }
  }
  const sourceLine = sourceLineForBodyLine(startLine, lineNumber)
  const story = storyLineNumbers.get(sourceLine)
  return story
    ? { physical, sequence: story.sequence, label: story.label, title: `English step ${story.sequence}` }
    : { physical, sequence: '', label: '' }
}

export function StepStatusBadge({ status }: { status: StepStatus }) {
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
    ? 'border-warning/60 bg-warning/15 dark:bg-warning/10'
    : `${colorClassForStatus(status)} bg-[var(--bg-surface)]`
  return (
    <li
      className={`rounded-md border ${cardClass} p-1.5`}
      style={isRunningStep ? { boxShadow: 'inset 3px 0 0 var(--warning)' } : undefined}
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
