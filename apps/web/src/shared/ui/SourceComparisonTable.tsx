import { useMemo, type Ref } from 'react'
import type { TestFileReview } from '@shared/test-review'
import { englishLines, type ContextRow } from '../lib/test-review-model'
import { ComparisonTable } from './ComparisonTable'
import { ReadableStoryText } from './ReadableTestView'
import { ShikiSourceLine } from './TestCodeBlock'
import { useCodeHighlight } from './use-code-highlight'
import type { TestLanguage } from './TestLanguageSwitch'

/** Keep diff rows source-aligned while sharing the cards' English grammar,
 * Shiki tokenization and format control. Never translate either baseline here. */
export function SourceComparisonTable({ review, rows, mode, change, scrollRef }: {
  review: TestFileReview; rows: ContextRow[]; mode: TestLanguage; change?: number; scrollRef?: Ref<HTMLDivElement>
}) {
  const before = useCodeHighlight(review.before.source)
  const after = useCodeHighlight(review.after.source)
  const english = useMemo(() => ({ before: englishLines(review.before), after: englishLines(review.after) }), [review])
  const render = (row: ContextRow, side: 'before' | 'after') => {
    const line = side === 'before' ? row.beforeLine : row.afterLine
    const source = row[side]
    if (line == null || source == null) return <span className="sr-only">No corresponding line</span>
    const story = english[side].get(line)
    const highlighted = side === 'before' ? before : after
    const content = mode === 'english' && story
      ? <span>{story.map(({ step, depth }) => <span key={step.id} className="cl-review-story-line" style={{ paddingLeft: `${depth * 12}px` }}><ReadableStoryText step={step} /></span>)}</span>
      : mode === 'english' && story === null && row.change == null ? <span aria-label="Continued above">{'\u00a0'}</span>
        : <ShikiSourceLine source={source} html={highlighted?.lines[line - 1]} />
    const Tag = row.change == null ? 'span' : side === 'before' ? 'del' : 'ins'
    return <div className="cl-review-source-line" data-source-line={line} data-side={side} style={{ color: highlighted?.canvas.fg }}>
      <Tag aria-label={row.change == null ? undefined : `${side === 'before' ? 'Removed' : 'Added'} source at line ${line}`}>{content}</Tag>
    </div>
  }
  return <div className="cl-review-source-canvas" style={{ background: after?.canvas.bg ?? before?.canvas.bg }}>
    <ComparisonTable rows={rows.map((row) => ({ ...row, fullSource: true, code: true,
      selected: change != null && row.change === change, sourceChanged: row.change != null,
      beforeContent: render(row, 'before'), afterContent: render(row, 'after'),
    }))} beforeLabel={`Before · ${review.baseline === 'run-start' ? 'Run snapshot' : 'Git HEAD'}`}
      afterLabel="After · Working copy" ariaLabel="Full test comparison" scrollRef={scrollRef} />
  </div>
}
