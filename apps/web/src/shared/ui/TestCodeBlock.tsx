import { useState } from 'react'
import type { ReactNode } from 'react'
import type { FormattedDisplayLine } from '@shared/code-display-format'
import type { ExtractedStep } from '@shared/extracted-test'
import * as workspaceApi from '../api/workspace'
import { useCodeHighlight } from './use-code-highlight'
import type { StoryCodeLineNumber } from './readable-story-sequence'
import {
  colorClassForStatus,
  statusLabel,
  statusPillClassForStatus,
  type StepStatus,
  type TestExecutionHighlightKind,
} from '@/features/runs/utils/test-step-status'
import { sourceLineForBodyLine } from '@/features/runs/utils/editor-location'

interface SourceLocation {
  file: string
  startLine: number
}

type OpenSourceAtLine = (line: number) => Promise<void>

interface ResolvedSourceLineMapping {
  sourceLine: number | null
  sourceLines: readonly number[]
}

interface CodeLineHighlight {
  kind: TestExecutionHighlightKind
  lines: ReadonlySet<number>
}

// Renders syntax-highlighted code using Shiki. The `source` prop comes from
// the feature's own spec files (server-side AST extraction), not untrusted
// user input, so innerHTML is safe here.
export function ShikiCode({
  source,
  lineHighlight,
  sourceLocation,
  sourceLineMap,
  changedLines,
  showOpenButton = true,
  selectedSourceRange,
  storyLineNumbers,
}: {
  source: string
  lineHighlight?: CodeLineHighlight
  sourceLocation?: SourceLocation
  /** Explicit display-row to absolute source-row mapping. When absent, rows
   *  retain the historical `startLine + displayRow - 1` mapping. */
  sourceLineMap?: readonly FormattedDisplayLine[]
  showOpenButton?: boolean
  selectedSourceRange?: { startLine: number; endLine: number }
  /** Absolute source line to the corresponding English story number. When
   * present, continuation and structural source rows intentionally stay blank. */
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>
  /** 1-indexed displayed rows to tint as changed — the diff-against-HEAD cue
   *  for a dirty test's body. Execution highlights take precedence when both
   *  refer to the same row. */
  changedLines?: Set<number>
}) {
  const html = useCodeHighlight(source)?.html ?? null

  const openClickedLine = (target: EventTarget | null, openAt: OpenSourceAtLine): void => {
    const line = (target as HTMLElement | null)?.closest<HTMLElement>('[data-source-line]')?.dataset.sourceLine
    if (line) void openAt(Number(line))
  }

  if (html === null) {
    return (
      <SourceOpenShell sourceLocation={sourceLocation} showOpenButton={showOpenButton}>
        {(openAt) => (
          <pre
            className={`cl-numbered-code cl-code-shell overflow-hidden whitespace-pre-wrap break-words rounded-md p-2 text-[11px] leading-[1.65] ${sourceLocation ? 'cursor-pointer' : ''}`}
            style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
            onClick={(event) => openClickedLine(event.target, openAt)}
          >
            <code>
              <FallbackCodeLines
                source={source}
                lineHighlight={lineHighlight}
                startLine={sourceLocation?.startLine}
                sourceLineMap={sourceLineMap}
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
          className={`shiki-block cl-numbered-code cl-code-shell overflow-hidden rounded-md text-[11px] leading-[1.65] ${sourceLocation ? '[&_span.line]:cursor-pointer [&_span.line:hover]:bg-running/10' : ''}`}
          onClick={(event) => openClickedLine(event.target, openAt)}
          // Shiki has already escaped the source it highlighted;
          // decorateShikiLines only adds metadata and presentation wrappers.
          // eslint-disable-next-line no-restricted-syntax
          dangerouslySetInnerHTML={{ __html: decorateShikiLines(html, lineHighlight, sourceLocation?.startLine, sourceLineMap, changedLines, selectedSourceRange, storyLineNumbers) }}
        />
      )}
    </SourceOpenShell>
  )
}

function FallbackCodeLines({
  source,
  lineHighlight,
  startLine,
  sourceLineMap,
  changedLines,
  selectedSourceRange,
  storyLineNumbers,
}: {
  source: string
  lineHighlight?: CodeLineHighlight
  startLine?: number
  sourceLineMap?: readonly FormattedDisplayLine[]
  changedLines?: Set<number>
  selectedSourceRange?: { startLine: number; endLine: number }
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>
}) {
  const shownStorySequences = new Set<string>()
  return source.split('\n').map((line, index) => {
    const lineNumber = index + 1
    const { mapped, number, selected, changed, active, executionKind, executionLabel, style } = codeLinePresentation(
      lineNumber,
      { lineHighlight, startLine, sourceLineMap, changedLines, selectedSourceRange, storyLineNumbers },
      shownStorySequences,
    )
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
        data-execution-highlight={executionKind}
        title={number.title}
        style={style}
      >
        <span className="cl-code-line-content">
          {line}
          {executionLabel && <span className="cl-execution-label cl-execution-label-failed">{executionLabel}</span>}
        </span>
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
      await workspaceApi.openEditor({ file: sourceLocation.file, line, column: 1 })
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
  lineHighlight?: CodeLineHighlight,
  startLine?: number,
  sourceLineMap?: readonly FormattedDisplayLine[],
  changedLines?: Set<number>,
  selectedSourceRange?: { startLine: number; endLine: number },
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>,
): string {
  let lineNo = 0
  const shownStorySequences = new Set<string>()
  const decorated = html.replace(/<span class="line"/g, (match) => {
    lineNo += 1
    const { mapped, number, selected, changed, active, executionKind, executionLabel, style } = codeLinePresentation(
      lineNo,
      { lineHighlight, startLine, sourceLineMap, changedLines, selectedSourceRange, storyLineNumbers },
      shownStorySequences,
    )
    const attrs = ` data-code-line="${number.physical}" data-code-sequence="${number.sequence}" data-code-sequence-label="${number.label}"${number.title ? ` title="${number.title}"` : ''}${mapped.sourceLine !== null ? ` data-source-line="${mapped.sourceLine}"` : ''}${selected ? ' data-selected-line="true"' : ''}`
    const flags = `${changed ? ' data-changed-line="true"' : ''}${active ? ` data-active-line="true" data-execution-highlight="${executionKind}"` : ''}${executionLabel ? ` data-execution-label="${executionLabel}"` : ''}`
    return `${match}${attrs}${flags}${style ? ` style="background:${style.background};box-shadow:${style.boxShadow}"` : ''}`
  })
  // A dedicated content cell keeps wrapped source aligned after the number
  // gutter. Shiki keeps each source line on one HTML line, so the final closing
  // span before its newline (or </code>) is the line wrapper, not a token span.
  return decorated
    .replace(/(<span class="line"[^>]*>)(.*)(<\/span>)(?=\n|<\/code>)/g, (_match, opening: string, content: string, closing: string) => {
      const executionLabel = opening.includes('data-execution-label="FAILED HERE"')
        ? '<span class="cl-execution-label cl-execution-label-failed">FAILED HERE</span>'
        : ''
      return `${opening}<span class="cl-code-line-content">${content}${executionLabel}</span>${closing}`
    })
    // Grid rows make Shiki's separator newlines visible under pre-wrap; the
    // source rows themselves already preserve every authored newline.
    .replace(/\n(?=<span class="line")/g, '')
}

interface CodeLinePresentationOptions {
  lineHighlight?: CodeLineHighlight
  startLine?: number
  sourceLineMap?: readonly FormattedDisplayLine[]
  changedLines?: ReadonlySet<number>
  selectedSourceRange?: { startLine: number; endLine: number }
  storyLineNumbers?: ReadonlyMap<number, StoryCodeLineNumber>
}

function codeLinePresentation(
  lineNumber: number,
  options: CodeLinePresentationOptions,
  shownStorySequences: Set<string>,
) {
  const { lineHighlight, startLine, sourceLineMap, changedLines, selectedSourceRange, storyLineNumbers } = options
  const mapped = sourceMappingForDisplayLine(lineNumber, startLine, sourceLineMap)
  const number = codeLineNumber(lineNumber, mapped.sourceLines, storyLineNumbers, shownStorySequences)
  const selected = sourceRangeIncludesAny(selectedSourceRange, mapped.sourceLines)
  const changed = changedLines?.has(lineNumber) === true
  const executionKind = lineHighlight?.lines.has(lineNumber) ? lineHighlight.kind : undefined
  const colors = executionKind
    ? codeLineHighlightColors(executionKind)
    : changed
      ? { background: 'color-mix(in srgb, var(--warning) 16%, transparent)', bar: 'var(--warning)' }
      : selected
        ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', bar: 'var(--accent)' }
        : undefined
  return {
    mapped, number, selected, changed,
    active: executionKind !== undefined,
    executionKind,
    executionLabel: executionKind === 'failed' ? 'FAILED HERE' : undefined,
    style: colors ? { background: colors.background, boxShadow: `inset 2px 0 0 ${colors.bar}` } : undefined,
  }
}

function codeLineHighlightColors(kind: TestExecutionHighlightKind): { background: string; bar: string } {
  return kind === 'failed'
    ? { background: 'color-mix(in srgb, var(--danger) 18%, transparent)', bar: 'var(--danger)' }
    : { background: 'color-mix(in srgb, var(--running) 18%, transparent)', bar: 'var(--running)' }
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

export function StepStatusBadge({ status, label }: { status: StepStatus; label?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${statusPillClassForStatus(status)}`}
      style={{ fontFamily: 'var(--font-mono)', minWidth: '3.5rem' }}
    >
      {label ?? statusLabel(status)}
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
            lineHighlight={activeLine == null
              ? undefined
              : { kind: 'running', lines: new Set([activeLine]) }}
            sourceLocation={sourceFile ? { file: sourceFile, startLine: step.line } : undefined}
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

/** A row from the same escaped Shiki output used by ShikiCode. Tokenization
 * happens on the whole file, never independently on a diff fragment. */
export function ShikiSourceLine({ source, html }: { source: string; html?: string }) {
  return html === undefined ? <span>{source || '\u00a0'}</span>
    // Shiki escapes source before producing these token spans.
    // eslint-disable-next-line no-restricted-syntax
    : <span dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />
}
