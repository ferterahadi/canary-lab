import { useMemo, type CSSProperties, type Ref } from 'react'
import type { TestFileReview } from '@shared/test-review'
import { englishLines, englishSourceRange, storyEndLine, type ContextRow } from '../lib/test-review-model'
import { ComparisonTable } from './ComparisonTable'
import { ReadableStoryText } from './ReadableTestView'
import { ShikiSourceLine } from './TestCodeBlock'
import { useCodeHighlight } from './use-code-highlight'
import type { TestLanguage } from './TestLanguageSwitch'

export interface ReviewSourceSelection { side: 'before' | 'after'; line: number; endLine: number }

/** Keep diff rows source-aligned while sharing the cards' English grammar,
 * Shiki tokenization and format control. Never translate either baseline here. */
export function SourceComparisonTable({ review, rows, mode, change, emptySide, scrollRef, selection, onSelectSource, returnSelection, onReturnToEnglish }: {
  review: TestFileReview; rows: ContextRow[]; mode: TestLanguage; change?: number; scrollRef?: Ref<HTMLDivElement>
  emptySide?: 'before' | 'after'
  selection?: ReviewSourceSelection | null; onSelectSource?: (selection: ReviewSourceSelection) => void
  returnSelection?: ReviewSourceSelection; onReturnToEnglish?: () => void
}) {
  const before = useCodeHighlight(review.before.source)
  const after = useCodeHighlight(review.after.source)
  const english = useMemo(() => ({ before: englishLines(review.before), after: englishLines(review.after) }), [review])
  const edits = useMemo(() => {
    const result = { before: new Map<number, number>(), after: new Map<number, number>() }
    for (const row of rows) if (row.change != null) {
      if (row.beforeLine != null && row.beforeChanged !== false) result.before.set(row.beforeLine, row.change)
      if (row.afterLine != null && row.afterChanged !== false) result.after.set(row.afterLine, row.change)
    }
    return result
  }, [rows])
  const cell = (row: ContextRow, side: 'before' | 'after') => {
    const line = side === 'before' ? row.beforeLine : row.afterLine
    const continued = mode === 'english' && line != null && english[side].get(line) === null
    const range = line == null ? undefined : mode === 'english' ? englishSourceRange(english[side], line) : { line, endLine: line }
    const changes = new Set<number>()
    if (range && !continued) for (let index = range.line; index <= range.endLine; index++) {
      const edit = edits[side].get(index)
      if (edit != null) changes.add(edit)
    }
    return { line, endLine: range?.endLine, continued, changes,
      label: continued || !range ? undefined : range.endLine > range.line ? `${range.line}–${range.endLine}` : range.line }
  }
  const render = (row: ContextRow, side: 'before' | 'after') => {
    const line = side === 'before' ? row.beforeLine : row.afterLine
    const source = row[side]
    if (line == null || source == null) return emptySide === side && row === rows[0]
      ? <span className="cl-comparison-empty">{side === 'after' ? 'Removed from current source' : 'Not present in recorded tests'}</span>
      : <span className="sr-only">No corresponding line</span>
    const story = english[side].get(line)
    const presentation = cell(row, side)
    const highlighted = side === 'before' ? before : after
    const content = mode === 'english' && story
      ? <span>{story.map(({ step, depth }) => onSelectSource
        ? <button key={step.id} type="button" className="cl-review-story-line cl-review-story-link" style={{ paddingLeft: `${depth * 12}px` }}
          title={`Show ${side === 'before' ? 'Before' : 'After'} code at line ${step.source.startLine}`}
          onClick={() => onSelectSource({ side, line: step.source.startLine, endLine: storyEndLine(step) })}>
          <ReadableStoryText step={step} />
        </button>
        : <span key={step.id} className="cl-review-story-line" style={{ paddingLeft: `${depth * 12}px` }}><ReadableStoryText step={step} /></span>)}</span>
      : presentation.continued ? <span aria-label="Continued above">{'\u00a0'}</span>
        : <ShikiSourceLine source={source} html={highlighted?.lines[line - 1]} />
    const Tag = presentation.changes.size === 0 ? 'span' : side === 'before' ? 'del' : 'ins'
    const sourceContent = mode === 'english' && onSelectSource && !story && !presentation.continued && source.trim()
      ? <button type="button" className="cl-review-story-link" title={`Show ${side === 'before' ? 'Before' : 'After'} code at line ${line}`}
        onClick={() => onSelectSource({ side, line, endLine: line })}>{content}</button>
      : content
    const selected = mode === 'code' && selection?.side === side && line >= selection.line && line <= selection.endLine
    const canReturn = mode === 'code' && onReturnToEnglish && returnSelection?.side === side && line >= returnSelection.line && line <= returnSelection.endLine
    const Line = canReturn ? 'button' : 'div'
    return <Line className={`cl-review-source-line${canReturn ? ' cl-review-story-link' : ''}`} data-source-line={line} data-source-end-line={presentation.endLine} data-source-continuation={presentation.continued || undefined} data-side={side} data-source-selected={selected || undefined}
      type={canReturn ? 'button' : undefined} title={canReturn ? `Show English for line ${returnSelection.line}` : undefined}
      onClick={canReturn ? onReturnToEnglish : undefined}
      tabIndex={selected ? -1 : undefined} style={{ color: highlighted?.canvas.fg }}>
      <Tag aria-label={presentation.changes.size === 0 ? undefined : `${side === 'before' ? 'Removed' : 'Added'} source at line ${line}`}>{sourceContent}</Tag>
    </Line>
  }
  const displayRows = rows.flatMap((row) => {
    const left = cell(row, 'before'); const right = cell(row, 'after')
    // Collapse the paired row only when neither side has independent content.
    // An insertion, deletion or differently wrapped statement keeps its alignment.
    if ((left.line == null || left.continued) && (right.line == null || right.continued)) return []
    return [{ ...row, beforeLine: left.label, afterLine: right.label, fullSource: true, code: true,
      selected: change != null && (left.changes.has(change) || right.changes.has(change)),
      sourceChanged: left.changes.size > 0 || right.changes.size > 0,
      beforeContent: render(row, 'before'), afterContent: render(row, 'after') }]
  })
  // Match the two-character source-number gutter used by `TestCodeBlock`.
  // Wider source locations still grow the gutter instead of shifting code over it.
  const gutterWidth = Math.max(2, ...displayRows.flatMap((row) => [String(row.beforeLine ?? '').length, String(row.afterLine ?? '').length]))
  return <div className="cl-review-source-canvas" style={{ background: after?.canvas.bg ?? before?.canvas.bg, '--review-gutter-width': `${gutterWidth}ch` } as CSSProperties}>
    <ComparisonTable rows={displayRows} beforeLabel={review.baseline === 'run-start' ? 'Recorded tests' : 'Committed tests · Git HEAD'}
      afterLabel="Current source" ariaLabel="Full test comparison" scrollRef={scrollRef} />
  </div>
}
