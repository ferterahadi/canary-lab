import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { FormattedDisplayLine } from '@shared/code-display-format'
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

type OpenSourceAtLine = (line: number) => Promise<void>

interface ResolvedSourceLineMapping {
  sourceLine: number | null
  sourceLines: readonly number[]
}

// Renders syntax-highlighted code using Shiki. The `source` prop comes from
// the feature's own spec files (server-side AST extraction), not untrusted
// user input, so innerHTML is safe here.
export function ShikiCode({
  source,
  activeLine,
  activeLines,
  sourceLocation,
  sourceLineMap,
  runningHighlight,
  changedLines,
  showOpenButton = true,
  selectedSourceRange,
  storyLineNumbers,
}: {
  source: string
  activeLine?: number | null
  activeLines?: ReadonlySet<number>
  sourceLocation?: SourceLocation
  /** Explicit display-row to absolute source-row mapping. When absent, rows
   *  retain the historical `startLine + displayRow - 1` mapping. */
  sourceLineMap?: readonly FormattedDisplayLine[]
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

  const openClickedLine = (target: EventTarget | null, openAt: OpenSourceAtLine): void => {
    const line = (target as HTMLElement | null)?.closest<HTMLElement>('[data-source-line]')?.dataset.sourceLine
    if (line) void openAt(Number(line))
  }

  if (html === null) {
    return (
      <SourceOpenShell sourceLocation={sourceLocation} showOpenButton={showOpenButton}>
        {(openAt) => (
          <pre
            className={`cl-numbered-code cl-code-shell overflow-x-auto overflow-y-hidden whitespace-pre break-normal rounded-md p-2 text-[11px] leading-[1.65] ${sourceLocation ? 'cursor-pointer' : ''}`}
            style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
            onClick={(event) => openClickedLine(event.target, openAt)}
          >
            <code>
              <FallbackCodeLines
                source={source}
                activeLine={activeLine}
                activeLines={activeLines}
                startLine={sourceLocation?.startLine}
                sourceLineMap={sourceLineMap}
                runningHighlight={runningHighlight}
                changedLines={changedLines}
                selectedSourceRange={selectedSourceRange}
                storyLineNumbers={storyLineNumbers}
              />
            </code>
          </pre>
        )}
      </SourceOpenShell>
    )
  }

  return (
    <SourceOpenShell sourceLocation={sourceLocation} showOpenButton={showOpenButton}>
      {(openAt) => (
        <div
          className={`shiki-block cl-numbered-code cl-code-shell overflow-x-auto overflow-y-hidden rounded-md text-[11px] leading-[1.65] ${sourceLocation ? '[&_span.line]:cursor-pointer [&_span.line:hover]:bg-running/10' : ''}`}
          onClick={(event) => openClickedLine(event.target, openAt)}
          // Shiki has already escaped the source it highlighted; decorateShikiLines
          // only wraps those tokens in spans.
          // eslint-disable-next-line no-restricted-syntax
          dangerouslySetInnerHTML={{ __html: decorateShikiLines(html, activeLine, activeLines, sourceLocation?.startLine, sourceLineMap, runningHighlight, changedLines, selectedSourceRange, storyLineNumbers) }}
        />
      )}
    </SourceOpenShell>
  )
}

function FallbackCodeLines({
  source,
  activeLine,
  activeLines,
  startLine,
  sourceLineMap,
  runningHighlight,
  changedLines,
  selectedSourceRange,
  storyLineNumbers,
}: {
  source: string
  activeLine?: number | null
  activeLines?: ReadonlySet<number>
  startLine?: number
  sourceLineMap?: readonly FormattedDisplayLine[]
  runningHighlight?: boolean
  changedLines?: Set<number>
  selectedSourceRange?: { startLine: number; endLine: number }
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>
}) {
  const shownStorySequences = new Set<string>()
  const activeBackground = runningHighlight
    ? 'color-mix(in srgb, var(--warning) 22%, transparent)'
    : 'color-mix(in srgb, var(--running) 18%, transparent)'
  const activeBar = runningHighlight ? 'var(--warning)' : 'var(--running)'
  return source.split('\n').map((line, index) => {
    const lineNumber = index + 1
    const mapped = sourceMappingForDisplayLine(lineNumber, startLine, sourceLineMap)
    const number = codeLineNumber(lineNumber, mapped.sourceLines, storyLineNumbers, shownStorySequences)
    const selected = sourceRangeIncludesAny(selectedSourceRange, mapped.sourceLines)
    const changed = changedLines?.has(lineNumber) === true
    const active = activeLines?.has(lineNumber) === true || lineNumber === activeLine
    const style = changed
      ? { background: 'color-mix(in srgb, var(--danger) 16%, transparent)', boxShadow: 'inset 2px 0 0 var(--danger)' }
      : active
        ? { background: activeBackground, boxShadow: `inset 2px 0 0 ${activeBar}` }
        : selected
          ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', boxShadow: 'inset 2px 0 0 var(--accent)' }
          : undefined
    return (
      <span
        key={index}
        className="line"
        data-code-line={number.physical}
        data-code-sequence={number.sequence}
        data-code-sequence-label={number.label}
        data-source-line={mapped.sourceLine ?? undefined}
        data-selected-line={selected ? 'true' : undefined}
        data-changed-line={changed ? 'true' : undefined}
        data-active-line={active ? 'true' : undefined}
        title={number.title}
        style={style}
      >
        {line}
      </span>
    )
  })
}

export function SourceOpenShell({
  children,
  sourceLocation,
  showOpenButton = true,
}: {
  children: ReactNode | ((openAt: OpenSourceAtLine) => ReactNode)
  sourceLocation?: SourceLocation
  showOpenButton?: boolean
}) {
  const [openError, setOpenError] = useState<string | null>(null)
  const openAt = async (line: number): Promise<void> => {
    if (!sourceLocation) return
    setOpenError(null)
    try {
      await api.openEditor({ file: sourceLocation.file, line, column: 1 })
    } catch (e: unknown) {
      setOpenError(e instanceof Error ? e.message : 'Failed to open editor')
    }
  }
  const content = typeof children === 'function' ? children(openAt) : children
  if (!sourceLocation) return <>{content}</>
  return (
    <div className="space-y-1">
      <div className="relative">
        {showOpenButton && (
          <button
            type="button"
            title="Open in editor"
            aria-label="Open in editor"
            onClick={() => { void openAt(sourceLocation.startLine) }}
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
        {content}
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
  activeLines?: ReadonlySet<number>,
  startLine?: number,
  sourceLineMap?: readonly FormattedDisplayLine[],
  runningHighlight?: boolean,
  changedLines?: Set<number>,
  selectedSourceRange?: { startLine: number; endLine: number },
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>,
): string {
  let lineNo = 0
  const shownStorySequences = new Set<string>()
  const bg = runningHighlight
    ? 'color-mix(in srgb, var(--warning) 22%, transparent)'
    : 'color-mix(in srgb, var(--running) 18%, transparent)'
  const bar = runningHighlight ? 'var(--warning)' : 'var(--running)'
  // Lines render as full-width blocks (`.shiki-block pre span.line`), so the
  // newline text nodes Shiki leaves between them must go — under pre-wrap each
  // would paint an extra blank row.
  return html.replace(/\n(?=<span class="line")/g, '').replace(/<span class="line"/g, (match) => {
    lineNo += 1
    const mapped = sourceMappingForDisplayLine(lineNo, startLine, sourceLineMap)
    const number = codeLineNumber(lineNo, mapped.sourceLines, storyLineNumbers, shownStorySequences)
    const selected = sourceRangeIncludesAny(selectedSourceRange, mapped.sourceLines)
    const attrs = ` data-code-line="${number.physical}" data-code-sequence="${number.sequence}" data-code-sequence-label="${number.label}"${number.title ? ` title="${number.title}"` : ''}${mapped.sourceLine !== null ? ` data-source-line="${mapped.sourceLine}"` : ''}${selected ? ' data-selected-line="true"' : ''}`
    if (changedLines?.has(lineNo)) {
      return `<span class="line"${attrs} data-changed-line="true" style="background:color-mix(in srgb, var(--danger) 16%, transparent);box-shadow:inset 2px 0 0 var(--danger)"`
    }
    if (activeLines?.has(lineNo) || lineNo === activeLine) {
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
  sourceLines: readonly number[],
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>,
  shownStorySequences?: Set<string>,
): {
  physical: string
  sequence: string
  label: string
  title?: string
} {
  const physical = String(lineNumber).padStart(2, '0')
  if (!storyLineNumbers) {
    return { physical, sequence: physical, label: physical }
  }
  const story = sourceLines.map((sourceLine) => storyLineNumbers.get(sourceLine)).find(Boolean)
  if (!story || shownStorySequences?.has(story.sequence)) {
    return { physical, sequence: '', label: '' }
  }
  shownStorySequences?.add(story.sequence)
  return { physical, sequence: story.sequence, label: story.label, title: `English step ${story.sequence}` }
}

function sourceMappingForDisplayLine(
  lineNumber: number,
  startLine?: number,
  sourceLineMap?: readonly FormattedDisplayLine[],
): ResolvedSourceLineMapping {
  const mapped = sourceLineMap?.[lineNumber - 1]
  if (mapped) {
    return mapped.sourceLines.length === 0
      ? { sourceLine: mapped.sourceLine, sourceLines: [mapped.sourceLine] }
      : mapped
  }
  if (startLine === undefined) return { sourceLine: null, sourceLines: [] }
  const sourceLine = sourceLineForBodyLine(startLine, lineNumber)
  return { sourceLine, sourceLines: [sourceLine] }
}

function sourceRangeIncludesAny(
  sourceRange: { startLine: number; endLine: number } | undefined,
  sourceLines: readonly number[],
): boolean {
  return sourceRange !== undefined && sourceLines.some(
    (sourceLine) => sourceLine >= sourceRange.startLine && sourceLine <= sourceRange.endLine,
  )
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
