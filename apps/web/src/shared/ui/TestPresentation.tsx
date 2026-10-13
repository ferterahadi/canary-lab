import { useMemo, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import type { FormattedDisplayLine } from '@shared/code-display-format'
import type { ExtractedTest } from '@shared/extracted-test'
import { storyEndLine } from '@shared/readable-tests/source-lines'
import { storyCodeLineNumbers, storyItemIdForSourceLine } from '@shared/readable-tests/story-source-map'
import { plural } from '@shared/lib/plural'
import type { ContextRow } from '@shared/test-source-diff'
import {
  alignedEnglishAvailable,
  alignedGutterWidth,
  alignedSideLabels,
  alignedTestViewRows,
  bodyLineForSourceLine,
  buildTestViewRows,
  markedRowIndexes,
  sourceLineForBodyLine,
  storyChangeMarks,
  testViewSource,
  type AlignedReview,
  type TestViewAlignedRow,
  type TestViewMode,
  type TestViewSelection,
  type TestViewSide,
  type TestViewSideLabels,
} from '@shared/test-view/render-model'
import type { ComparisonRow } from './ComparisonTable'
import type { TestExecutionLineHighlight } from '@/features/runs/utils/test-step-status'
import { ComparisonTable } from './ComparisonTable'
import { ReadableStoryText, ReadableTestView, type ReadableSourceSelection } from './ReadableTestView'
import { ShikiCode, ShikiMarkedLine, ShikiSourceLine, SourceOpenShell } from './TestCodeBlock'
import { TestLanguageSwitch } from './TestLanguageSwitch'
import type { CodeLanguage } from './code-highlighter'
import { useCodeHighlight } from './use-code-highlight'

interface TestPresentationShellProps {
  /** The format on show. Supplying it makes the toggle controlled; absent, the
   * view keeps its own and opens in English. */
  mode?: TestViewMode
  onModeChange?: (mode: TestViewMode) => void
  /** Content beside the format toggle in the header row. */
  header?: ReactNode
}

/** One test's story and body: the Tests column and the coverage cards. */
export interface TestPresentationSingleProps extends TestPresentationShellProps {
  view: 'single'
  test: ExtractedTest
  sourceFile: string
  executionHighlight?: TestExecutionLineHighlight | null
  changedLines?: Set<number>
  showOpenButton?: boolean
}

/** A whole file before and after with its rows paired across the two sides:
 * the "Compare test versions" review, and a repair cycle's Code changes. One
 * table with one scroller — two
 * independent cards would lose the pairing after an insertion or deletion,
 * each side's English folding, and the review's edit navigation. */
export interface TestPresentationAlignedProps extends TestPresentationShellProps {
  view: 'aligned'
  review: AlignedReview
  rows: ContextRow[]
  /** Column headings; absent, they name the review's baseline. */
  labels?: TestViewSideLabels
  /** `word` marks the changed words inside an edited line. */
  marks?: 'line' | 'word'
  /** The listing has no English to offer; the toggle stays, disabled, with
   * this reason. */
  codeOnly?: { reason: string }
  ariaLabel?: string
  /** The edit whose rows read as selected. */
  change?: number
  /** The side an added or removed test is absent from; its first row says so. */
  emptySide?: TestViewSide
  /** What that first row says; absent, it names the review's own baseline. */
  emptySideLabel?: string
  /** The grammar both sides are coloured with; TypeScript when absent. */
  lang?: CodeLanguage
  /** The Code-mode range opened from an English row. */
  selection?: TestViewSelection | null
  onSelectSource?: (selection: TestViewSelection) => void
  /** The Code-mode rows that lead back to the English row they were opened from. */
  returnSelection?: TestViewSelection
  onReturnToEnglish?: () => void
  scrollRef?: Ref<HTMLDivElement>
  /** A notice about the listing as a whole, read before it: between the
   *  toolbar and the table. */
  notice?: ReactNode
}

export type TestPresentationProps = TestPresentationSingleProps | TestPresentationAlignedProps

/** A view's props once the shell has settled which format shows. */
type Resolved<P extends TestPresentationShellProps> = Omit<P, 'mode' | 'onModeChange'> & {
  mode: TestViewMode
  onModeChange: (mode: TestViewMode) => void
}

export function TestPresentation(props: TestPresentationProps) {
  const [ownMode, setOwnMode] = useState<TestViewMode>('english')
  const mode = props.mode ?? ownMode
  const changeMode = (next: TestViewMode): void => {
    if (props.mode === undefined) setOwnMode(next)
    props.onModeChange?.(next)
  }
  return props.view === 'aligned'
    ? <AlignedTestView {...props} mode={mode} onModeChange={changeMode} />
    : <SingleTestView {...props} mode={mode} onModeChange={changeMode} />
}

function SingleTestView({
  test,
  sourceFile,
  executionHighlight,
  changedLines: suppliedChangedLines,
  showOpenButton = true,
  mode,
  onModeChange,
  header,
}: Resolved<TestPresentationSingleProps>) {
  const changedLines = useMemo(() => suppliedChangedLines ?? (test.sourceChanges
    ? new Set(test.sourceChanges.changedLines.map((line) => bodyLineForSourceLine(test, line)))
    : undefined), [suppliedChangedLines, test])
  const [selectedSource, setSelectedSource] = useState<ReadableSourceSelection | null>(null)

  const selectSource = (selection: ReadableSourceSelection) => {
    setSelectedSource(selection)
    onModeChange('code')
  }
  const code = testViewSource(test, sourceFile, selectedSource?.source)
  const visibleRange = selectedSource?.source ?? code
  const fullTestRange = testViewSource(test, sourceFile, undefined)
  const rows = buildTestViewRows({
    test,
    sourceFile,
    selectedSource: selectedSource?.source,
    execution: executionHighlight ?? undefined,
    changedBodyLines: changedLines,
  })
  const displayedExecutionLines = markedRowIndexes(rows, (marks) => marks.execution !== undefined)
  const displayedChangedLines = markedRowIndexes(rows, (marks) => marks.changed)
  const storyLineNumbers = useMemo(() => {
    const steps = test.readable.story?.steps
    if (!steps) return undefined
    return storyCodeLineNumbers(
      steps,
      code.file,
      code.startLine,
      code.endLine,
    )
  }, [code.endLine, code.file, code.startLine, test.readable.story?.steps])
  const executionSourceLine = executionHighlight
    ? sourceLineForBodyLine(test, executionHighlight.bodyLine)
    : undefined
  const executionStoryNodeId = executionSourceLine == null || !test.readable.story
    ? undefined
    : storyItemIdForSourceLine(test.readable.story.steps, sourceFile, executionSourceLine)
  const changedStory = useMemo(() => storyChangeMarks(test, sourceFile, changedLines), [changedLines, sourceFile, test])

  return (
    <div data-testid="test-presentation">
      <div className="mb-2 flex min-w-0 items-center gap-2 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <TestLanguageSwitch mode={mode} onChange={onModeChange} />
        {header}
        {mode === 'english' && test.readable.completeness === 'partial' && (
          <span className="min-w-0 truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
            English representation is incomplete
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-right text-[10px]"
          title={mode === 'code' ? code.file : fullTestRange.file}
          style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
        >
          {mode === 'code'
            ? shortSourceLabel(visibleRange.file, visibleRange.startLine, visibleRange.endLine)
            : shortSourceLabel(fullTestRange.file, fullTestRange.startLine, fullTestRange.endLine)}
        </span>
        {mode === 'code' && selectedSource && (
          <button
            type="button"
            className="shrink-0 text-[10px]"
            style={{ color: 'var(--accent)' }}
            onClick={() => setSelectedSource(null)}
          >
            Full test
          </button>
        )}
      </div>

      {mode === 'english' ? (
        <div data-testid="test-presentation-english">
          {changedStory.unmappedSourceLines.length > 0 && (
            <div
              data-testid="readable-unmapped-change"
              className="mb-2 flex items-start gap-2 rounded-md border px-2 py-1.5 text-[10px]"
              style={{
                color: 'var(--danger)',
                borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))',
                background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
              }}
            >
              <span className="min-w-0 flex-1">
                Modified source at {formatSourceLines(changedStory.unmappedSourceLines)} has no executable English step. This includes changes such as a check being commented out.
              </span>
              <button
                type="button"
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={() => onModeChange('code')}
              >
                View exact diff
              </button>
            </div>
          )}
          <SourceOpenShell
            sourceLocation={{
              file: fullTestRange.file,
              startLine: firstMappedSourceLine(fullTestRange.lineMap) ?? fullTestRange.startLine,
            }}
            showOpenButton={showOpenButton}
          >
            <ReadableTestView
              test={test.readable}
              sourceFile={sourceFile}
              selectedNodeId={selectedSource?.id}
              executionHighlight={executionHighlight && executionStoryNodeId
                ? { kind: executionHighlight.kind, nodeId: executionStoryNodeId }
                : undefined}
              changedNodeIds={changedStory.nodeIds}
              onSourceSelect={selectSource}
            />
          </SourceOpenShell>
        </div>
      ) : (
        <div data-testid="test-presentation-code">
          {code.source ? (
            <ShikiCode
              source={code.source}
              lineHighlight={executionHighlight && displayedExecutionLines
                ? { kind: executionHighlight.kind, lines: displayedExecutionLines }
                : undefined}
              sourceLocation={{ file: code.file, startLine: firstMappedSourceLine(code.lineMap) ?? code.startLine }}
              sourceLineMap={code.lineMap}
              changedLines={displayedChangedLines}
              showOpenButton={showOpenButton}
              selectedSourceRange={selectedSource?.source}
              storyLineNumbers={storyLineNumbers}
            />
          ) : (
            <div className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
              No test body available.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Diff rows stay source-aligned while sharing the single view's English
 * grammar, Shiki tokenization and format toggle. Neither baseline is ever
 * translated here: both sides arrive as the server reviewed them. */
function AlignedTestView({
  review, rows, mode, onModeChange, header, change, emptySide, emptySideLabel, scrollRef, selection, onSelectSource, returnSelection, onReturnToEnglish, notice,
  labels, marks, codeOnly, lang, ariaLabel = 'Full test comparison',
}: Resolved<TestPresentationAlignedProps>) {
  const englishAvailable = !codeOnly && alignedEnglishAvailable(review)
  const shownMode = englishAvailable ? mode : 'code'
  const before = useCodeHighlight(review.before.source, lang)
  const after = useCodeHighlight(review.after.source, lang)
  const aligned = useMemo(() => alignedTestViewRows({ review, rows, mode: shownMode, marks, change, selection }), [change, shownMode, marks, review, rows, selection])
  const render = (pair: TestViewAlignedRow, side: TestViewSide) => {
    const cell = side === 'before' ? pair.before : pair.after
    const source = pair.source[side]
    if (cell === undefined || source == null) return emptySide === side && pair.source === rows[0]
      ? <span className="cl-comparison-empty">{emptySideLabel ?? (side === 'after' ? 'Removed from current source' : 'Not present in recorded tests')}</span>
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
      : cell.continued ? <span aria-label="Continued above">{' '}</span>
        : shownMode === 'english' && source.trim()
          ? <span style={{ color: 'var(--semantic-attention)' }}>English unavailable · View code</span>
          : cell.marks.words
            ? <ShikiMarkedLine html={highlighted?.lines[line - 1]} parts={cell.marks.words} />
            : <ShikiSourceLine source={source} html={highlighted?.lines[line - 1]} />
    const Tag = cell.marks.changes.size === 0 ? 'span' : side === 'before' ? 'del' : 'ins'
    const sourceContent = shownMode === 'english' && onSelectSource && !cell.english && !cell.continued && source.trim()
      ? <button type="button" className="cl-review-story-link" title={`Show ${side === 'before' ? 'Before' : 'After'} code at line ${line}`}
        onClick={() => onSelectSource({ side, line, endLine: line })}>{content}</button>
      : content
    const canReturn = shownMode === 'code' && onReturnToEnglish && returnSelection?.side === side && line >= returnSelection.line && line <= returnSelection.endLine
    const Line = canReturn ? 'button' : 'div'
    return <Line className={`cl-review-source-line${canReturn ? ' cl-review-story-link' : ''}`} data-source-line={line} data-source-end-line={cell.endLine} data-source-continuation={cell.continued || undefined} data-side={side} data-source-selected={cell.marks.selected || undefined}
      type={canReturn ? 'button' : undefined} title={canReturn ? `Show English for line ${returnSelection.line}` : undefined}
      onClick={canReturn ? onReturnToEnglish : undefined}
      tabIndex={cell.marks.selected ? -1 : undefined} style={{ color: highlighted?.canvas.fg }}>
      <Tag aria-label={cell.marks.changes.size === 0 ? undefined : `${side === 'before' ? 'Removed' : 'Added'} source at line ${line}`}>{sourceContent}</Tag>
    </Line>
  }
  const displayRows = aligned.flatMap((pair): ComparisonRow[] => {
    const row: ComparisonRow = { ...pair.source, beforeLine: pair.before?.label, afterLine: pair.after?.label, fullSource: true, code: true,
      selected: pair.selected, sourceChanged: pair.sourceChanged,
      beforeContent: render(pair, 'before'), afterContent: render(pair, 'after') }
    const { gap } = pair.source
    // Lines a patch leaves out sit between its hunks; say how many, per side
    // only when the sides differ.
    return gap ? [{ id: `${pair.source.id}-gap`, kind: 'section', label: gap.before === gap.after
      ? `${plural(gap.after, 'unchanged line')} not in this patch`
      : `${plural(gap.before, 'unchanged line')} before · ${plural(gap.after, 'unchanged line')} after, not in this patch` }, row] : [row]
  })
  const headings = labels ?? alignedSideLabels(review)
  return <>
    <div className="cl-context-toolbar">
      {codeOnly
        ? <TestLanguageSwitch mode="code" onChange={onModeChange} disabled={codeOnly} />
        : englishAvailable
          ? <TestLanguageSwitch mode={mode} onChange={onModeChange} />
          : <span className="text-xs text-secondary">Supporting file · Code</span>}
      {header}
    </div>
    {notice}
    <div className="cl-context-table min-h-0 flex-1">
      <div className="cl-review-source-canvas" style={{
        background: after?.canvas.bg ?? before?.canvas.bg,
        '--code-comment': after?.canvas.comment ?? before?.canvas.comment ?? 'var(--text-muted)',
        '--review-gutter-width': `${alignedGutterWidth(aligned)}ch`,
      } as CSSProperties}>
        <ComparisonTable rows={displayRows} beforeLabel={headings.before} afterLabel={headings.after} ariaLabel={ariaLabel} scrollRef={scrollRef} />
      </div>
    </div>
  </>
}

function formatSourceLines(lines: readonly number[]): string {
  return lines.map((line) => `L${line}`).join(', ')
}

function firstMappedSourceLine(lineMap: readonly FormattedDisplayLine[]): number | null {
  return lineMap[0]?.sourceLine ?? null
}

function shortSourceLabel(file: string, startLine: number, endLine: number): string {
  const parts = file.split(/[\\/]/)
  const shortFile = parts.slice(-2).join('/')
  const line = startLine === endLine ? `L${startLine}` : `L${startLine}–${endLine}`
  return `${shortFile}:${line}`
}
