import { useMemo, type CSSProperties, type Ref } from 'react'
import type { TestFileReview } from '@shared/test-review'
import { storyEndLine } from '@shared/readable-tests/source-lines'
import type { ContextRow } from '@shared/test-source-diff'
import { alignedTestViewRows, type TestViewAlignedRow, type TestViewSide } from '@shared/test-view/render-model'
import { ComparisonTable } from './ComparisonTable'
import { ReadableStoryText } from './ReadableTestView'
import { ShikiSourceLine } from './TestCodeBlock'
import { useCodeHighlight } from './use-code-highlight'
import type { TestLanguage } from './TestLanguageSwitch'

export interface ReviewSourceSelection { side: TestViewSide; line: number; endLine: number }

/** Keep diff rows source-aligned while sharing the cards' English grammar,
 * Shiki tokenization and format control. Never translate either baseline here. */
export function SourceComparisonTable({ review, rows, mode, change, emptySide, scrollRef, selection, onSelectSource, returnSelection, onReturnToEnglish }: {
  review: TestFileReview; rows: ContextRow[]; mode: TestLanguage; change?: number; scrollRef?: Ref<HTMLDivElement>
  emptySide?: TestViewSide
  selection?: ReviewSourceSelection | null; onSelectSource?: (selection: ReviewSourceSelection) => void
  returnSelection?: ReviewSourceSelection; onReturnToEnglish?: () => void
}) {
  const before = useCodeHighlight(review.before.source)
  const after = useCodeHighlight(review.after.source)
  const aligned = useMemo(() => alignedTestViewRows({ review, rows, mode, change, selection }), [change, mode, review, rows, selection])
  const render = (pair: TestViewAlignedRow, side: TestViewSide) => {
    const cell = side === 'before' ? pair.before : pair.after
    const source = pair.source[side]
    if (cell === undefined || source == null) return emptySide === side && pair.source === rows[0]
      ? <span className="cl-comparison-empty">{side === 'after' ? 'Removed from current source' : 'Not present in recorded tests'}</span>
      : <span className="sr-only">No corresponding line</span>
    const line = cell.sourceLine
    const highlighted = side === 'before' ? before : after
    const content = cell.english
      ? <span>{cell.english.map(({ step, depth }) => onSelectSource
        ? <button key={step.id} type="button" className="cl-review-story-line cl-review-story-link" style={{ paddingLeft: `${depth * 12}px` }}
          title={`Show ${side === 'before' ? 'Before' : 'After'} code at line ${step.source.startLine}`}
          onClick={() => onSelectSource({ side, line: step.source.startLine, endLine: storyEndLine(step) })}>
          <ReadableStoryText step={step} />
        </button>
        : <span key={step.id} className="cl-review-story-line" style={{ paddingLeft: `${depth * 12}px` }}><ReadableStoryText step={step} /></span>)}</span>
      : cell.continued ? <span aria-label="Continued above">{' '}</span>
        : mode === 'english' && source.trim()
          ? <span style={{ color: 'var(--semantic-attention)' }}>English unavailable · View code</span>
          : <ShikiSourceLine source={source} html={highlighted?.lines[line - 1]} />
    const Tag = cell.marks.changes.size === 0 ? 'span' : side === 'before' ? 'del' : 'ins'
    const sourceContent = mode === 'english' && onSelectSource && !cell.english && !cell.continued && source.trim()
      ? <button type="button" className="cl-review-story-link" title={`Show ${side === 'before' ? 'Before' : 'After'} code at line ${line}`}
        onClick={() => onSelectSource({ side, line, endLine: line })}>{content}</button>
      : content
    const canReturn = mode === 'code' && onReturnToEnglish && returnSelection?.side === side && line >= returnSelection.line && line <= returnSelection.endLine
    const Line = canReturn ? 'button' : 'div'
    return <Line className={`cl-review-source-line${canReturn ? ' cl-review-story-link' : ''}`} data-source-line={line} data-source-end-line={cell.endLine} data-source-continuation={cell.continued || undefined} data-side={side} data-source-selected={cell.marks.selected || undefined}
      type={canReturn ? 'button' : undefined} title={canReturn ? `Show English for line ${returnSelection.line}` : undefined}
      onClick={canReturn ? onReturnToEnglish : undefined}
      tabIndex={cell.marks.selected ? -1 : undefined} style={{ color: highlighted?.canvas.fg }}>
      <Tag aria-label={cell.marks.changes.size === 0 ? undefined : `${side === 'before' ? 'Removed' : 'Added'} source at line ${line}`}>{sourceContent}</Tag>
    </Line>
  }
  const displayRows = aligned.map((pair) => ({ ...pair.source, beforeLine: pair.before?.label, afterLine: pair.after?.label, fullSource: true, code: true,
    selected: pair.selected, sourceChanged: pair.sourceChanged,
    beforeContent: render(pair, 'before'), afterContent: render(pair, 'after') }))
  // Match the two-character source-number gutter used by `TestCodeBlock`.
  // Wider source locations still grow the gutter instead of shifting code over it.
  const gutterWidth = Math.max(2, ...displayRows.flatMap((row) => [(row.beforeLine ?? '').length, (row.afterLine ?? '').length]))
  return <div className="cl-review-source-canvas" style={{
    background: after?.canvas.bg ?? before?.canvas.bg,
    '--code-comment': after?.canvas.comment ?? before?.canvas.comment ?? 'var(--text-muted)',
    '--review-gutter-width': `${gutterWidth}ch`,
  } as CSSProperties}>
    <ComparisonTable rows={displayRows} beforeLabel={review.baseline === 'run-start' ? 'Recorded tests' : 'Committed tests · Git HEAD'}
      afterLabel="Current source" ariaLabel="Full test comparison" scrollRef={scrollRef} />
  </div>
}

