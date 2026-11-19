import type { FlowRange } from '@shared/test-view/flow-graph'
import { projectFlowAttempt, type FlowAttempt, type FlowVisit } from '@shared/test-view/flow-execution'
import type { FlowInspection } from '../lib/workspace-view-state'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { parseSourceLocation } from '@shared/lib/source-location'
import type { FormattedDisplayLine } from '@shared/code-display-format'
import type { ExtractedTest } from '@shared/extracted-test'
import { storyEndLine } from '@shared/readable-tests/source-lines'
import { storyCodeLineNumbers, storyItemIdForExactRange, storyItemIdForSourceLine } from '@shared/readable-tests/story-source-map'
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
  type SingleTestViewMode,
  type TestViewSelection,
  type TestViewSide,
  type TestViewSideLabels,
} from '@shared/test-view/render-model'
import type { ComparisonRow } from './ComparisonTable'
import type { TestExecutionLineHighlight } from '@/features/runs/utils/test-step-status'
import { ComparisonTable } from './ComparisonTable'
import { ReadableStoryText, ReadableTestView, type ReadableSourceSelection } from './ReadableTestView'
import { ShikiCode, ShikiMarkedLine, ShikiSourceLine, SourceOpenShell } from './TestCodeBlock'
import { flowSections, sectionNodes, stepVisitKey, type FlowSection } from './test-flow-layout'
import { VisualTestView } from './VisualTestView'
import { TestLanguageSwitch } from './TestLanguageSwitch'
import type { CodeLanguage } from './code-highlighter'
import { useCodeHighlight } from './use-code-highlight'

interface TestPresentationShellProps<M extends SingleTestViewMode = TestViewMode> {
  /** The format on show. Supplying it makes the toggle controlled; absent, the
   * view keeps its own and opens in English. */
  mode?: M
  onModeChange?: (mode: M) => void
  /** Content beside the format toggle in the header row. */
  header?: ReactNode
}

/** One test's story and body: the Tests column and the coverage cards. */
export interface TestPresentationSingleProps extends TestPresentationShellProps<SingleTestViewMode> {
  inspection?: FlowInspection
  onInspection?: (state: FlowInspection) => void
  view: 'single'
  attempts?: FlowAttempt[]
  liveAttempt?: boolean
  stepCounts?: ReadonlyMap<string, number>
  runningLocation?: string
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
  onVisual?: () => void
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
type Resolved<P extends { mode?: SingleTestViewMode }> = P & {
  mode: NonNullable<P['mode']>
  onModeChange: (mode: NonNullable<P['mode']>) => void
}

function usePresentationMode<M extends SingleTestViewMode>(props: TestPresentationShellProps<M>, initial: M) {
  const [ownMode, setOwnMode] = useState(initial)
  return {
    mode: props.mode ?? ownMode,
    onModeChange: (next: M) => {
      if (props.mode === undefined) setOwnMode(next)
      props.onModeChange?.(next)
    },
  }
}

export function TestPresentation(props: TestPresentationProps) {
  return props.view === 'single' ? <SinglePresentation key={JSON.stringify([props.sourceFile, props.test.line, props.test.name])} {...props} /> : <AlignedPresentation {...props} />
}

function attemptLabel(attempt: FlowAttempt) {
  return ['Attempt ' + (attempt.retry + 1), attempt.status, attempt.execution && 'execution ' + attempt.execution].filter(Boolean).join(' · ')
}

function SinglePresentation(props: TestPresentationSingleProps) {
  const [local, setLocal] = useState<FlowInspection>({ mode: 'english' })
  const inspection = props.onInspection ? props.inspection ?? { mode: 'english' as const } : local
  const picked = inspection.section
  function change(next: FlowInspection) {
    setLocal(next)
    props.onInspection?.(next)
    if (next.mode !== (props.mode ?? inspection.mode)) props.onModeChange?.(next.mode)
  }
  const mode = props.mode ?? inspection.mode
  const setPicked = (id?: string) => change({ mode, section: id, fit: inspection.fit })

  const sections = useMemo(() => flowSections(props.test.readable.nodes, props.test.readable.graph?.schemaVersion === 1 ? props.test.readable.graph : undefined), [props.test.readable])
  const indexed = useMemo(() => sections.flatMap(section => sectionNodes(section).map(node => ({ section, node }))), [sections])
  const [pinnedAttempt, setPinnedAttempt] = useState('')
  const latest = props.attempts?.at(-1)
  const attempt = props.attempts?.find(a => a.key === pinnedAttempt) ?? latest
  const overlay = useMemo(() => attempt && projectFlowAttempt(props.test.readable.graph, attempt,
    Boolean(props.liveAttempt && attempt === latest)), [attempt, latest, props.liveAttempt, props.test.readable.graph])
  const observed = overlay?.active
  const location = props.attempts ? observed?.box.range && observed.box.range.file + ':' + observed.box.range.startLine : props.runningLocation
  const live = location && parseSourceLocation(location)
  const matches = live ? indexed.filter(({ node }) => node.source.file === live.file && node.source.startLine === Number(live.line)) : []
  const active = props.attempts ? matches.find(m => m.node.id === observed?.box.sourceId && m.section.id === observed.section.id)
    : matches.length === 1 ? matches[0] : undefined
  const section = sections.find(s => s.id === picked) ?? (!picked ? active?.section : undefined) ?? sections[0]
  const implementation = section.implementation
  const sourceFile = implementation?.source.file ?? props.sourceFile
  const checks = useMemo(() => {
    const counts = new Map<number, number>()
    if (overlay) {
      for (const box of section.topology?.boxes ?? []) {
        const n = overlay.sections.get(section.id)?.get(box.id)?.checks
        if (n && box.range?.file === sourceFile) counts.set(box.range.startLine, n)
      }
      return counts
    }
    if (!props.stepCounts?.size) return counts
    const locations = new Map<number, number>()
    for (const { node } of indexed) {
      const { file, startLine } = node.source
      if (file === sourceFile) locations.set(startLine, (locations.get(startLine) ?? 0) + 1)
    }
    for (const { section: owner, node } of indexed) {
      if (owner !== section || node.kind !== 'loop' || !node.flow) continue
      const { file, startLine } = node.source
      // Repeated calls to one helper share a definition. A source line
      // alone cannot assign a completed check to one of those invocations.
      if (file !== sourceFile || locations.get(startLine) !== 1) continue
      const count = props.stepCounts.get(stepVisitKey(`${file}:${startLine}`, node.flow.label))
      if (count) counts.set(startLine, count)
    }
    return counts
  }, [indexed, section, sourceFile, props.stepCounts, overlay])
  const test = useMemo((): ExtractedTest => implementation ? {
    name: section.label, line: implementation.source.startLine, bodySource: implementation.source.snippet, steps: [],
    readable: { ...props.test.readable, title: section.label, nodes: section.nodes, story: implementation.story },
  } : props.test, [section, implementation, props.test])
  const picker = <div className="cl-flow-picker text-xs">
    {attempt && <label>Attempt <select aria-label="Execution attempt" value={pinnedAttempt && attempt.key === pinnedAttempt ? pinnedAttempt : ''}
      onChange={event => setPinnedAttempt(event.target.value)}>
      <option value="">Latest · {attemptLabel(latest!)}</option>
      {props.attempts?.map(a => <option key={a.key} value={a.key}>{attemptLabel(a)}</option>)}
    </select></label>}
    {mode === 'visual' && props.attempts && <span className="text-muted">{overlay?.reason ?? (!attempt ? 'No attempt recorded.' :
      ['Unmarked boxes have no mapped observation.', overlay?.incomplete && 'Incomplete event sequence.',
        overlay?.unavailable ? `${overlay.unavailable} steps without an exact box.` : null].filter(Boolean).join(' '))}</span>}
    {sections.length > 1 && <label className="contents">Flow <select aria-label="Flow" value={section.id} onChange={event => setPicked(event.target.value)}>
      {sections.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
    </select></label>}
    {section.parent && <button type="button" onClick={() => setPicked(section.parent)}>Back to caller</button>}
    {props.runningLocation && <button type="button" onClick={() => {
      if (picked || pinnedAttempt) { setPinnedAttempt(''); setPicked(undefined) }
      else setPicked(section.id)
    }}>{picked || pinnedAttempt ? 'Follow run' : 'Pause following'}</button>}
  </div>
  const helper = section.id !== 'test'
  const latestFailure = attempt === latest && attempt?.status === 'failed' && !overlay?.reason && props.executionHighlight?.kind === 'failed'
  return <SingleTestView key={section.id} {...props} mode={mode} onModeChange={next => change({ ...inspection, mode: next })}
    inspection={inspection} updateInspection={change} test={test}
    sourceFile={sourceFile}
    changedLines={helper ? undefined : props.changedLines}
    visits={overlay?.sections.get(section.id)} runningLocation={location}
    verifiedOverlay={props.attempts !== undefined} observedRange={observed?.section.id === section.id ? observed.box.range : undefined}
    executionHighlight={helper || (props.attempts && !latestFailure) ? undefined : props.executionHighlight}
    section={section} checks={checks} picker={picker} active={active?.section === section ? active.node.id : undefined} onPick={setPicked} />
}

function AlignedPresentation(props: TestPresentationAlignedProps) {
  return <AlignedTestView {...props} {...usePresentationMode<TestViewMode>(props, 'english')} />
}

function SingleTestView({
  test,
  section, checks, picker, active, onPick, inspection, updateInspection, visits, verifiedOverlay, observedRange,
  sourceFile,
  executionHighlight,
  runningLocation,
  changedLines: suppliedChangedLines,
  showOpenButton = true,
  mode,
  onModeChange,
  header,
}: Resolved<TestPresentationSingleProps> & {
  inspection: FlowInspection; updateInspection: (state: FlowInspection) => void
  visits?: Map<string, FlowVisit>; verifiedOverlay: boolean; observedRange?: FlowRange
  checks: ReadonlyMap<number, number>
  section: FlowSection; picker: ReactNode; active?: string; onPick: (id: string) => void
}) {
  const changedLines = useMemo(() => suppliedChangedLines ?? (test.sourceChanges
    ? new Set(test.sourceChanges.changedLines.map((line) => bodyLineForSourceLine(test, line)))
    : undefined), [suppliedChangedLines, test])
  const [storySelection, setStorySelection] = useState<ReadableSourceSelection | null>(null)
  const graphNode = useMemo(() => inspection.node ? sectionNodes(section).find(n => n.id === inspection.node) : undefined, [section, inspection.node])
  const definition = graphNode?.kind === 'group' && graphNode.implementation?.source
  const selectedSource = graphNode ? { id: graphNode.id, source: inspection.definition && definition ? definition : graphNode.source } : storySelection
  const fromVisual = Boolean(graphNode)
  const visual = mode === 'visual'
  const listing = useRef<HTMLDivElement>(null)
  const viewport = useRef<{ left: number; top: number; ancestors: [HTMLElement, number, number][] } | null>(null)
  useLayoutEffect(() => {
    if (mode !== 'code' || !selectedSource) return
    const line = listing.current?.querySelector<HTMLElement>('[data-selected-line="true"]')
    line?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    if (line) { line.tabIndex = -1; line.focus({ preventScroll: true }) }
  }, [mode, selectedSource?.id, inspection.definition])
  const selectSource = (selection: ReadableSourceSelection, box?: string) => {
    setStorySelection(visual ? null : selection)
    updateInspection({ ...inspection, mode: 'code', section: section.id,
      node: visual ? selection.id : undefined, box: visual ? box ?? selection.id : undefined, definition: undefined })
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
  const liveSource = runningLocation ? parseSourceLocation(runningLocation) : undefined
  const helper = section.id !== 'test'
  const useLiveLine = fromVisual || helper || (verifiedOverlay && !executionHighlight)
  const visualLines = useLiveLine && ((!helper && !verifiedOverlay) || active) && liveSource?.file === code.file
    ? new Set(code.lineMap.flatMap((line, index) => line.sourceLines.includes(Number(liveSource.line)) ? [index + 1] : []))
    : undefined
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
  const executionSourceLine = (verifiedOverlay || helper) && active && liveSource?.file === sourceFile ? Number(liveSource.line) : executionHighlight
    ? sourceLineForBodyLine(test, executionHighlight.bodyLine)
    : undefined
  const executionStoryNodeId = executionSourceLine == null || !test.readable.story
    ? undefined
    : observedRange ? storyItemIdForExactRange(test.readable.story.steps, observedRange)
      : storyItemIdForSourceLine(test.readable.story.steps, sourceFile, executionSourceLine)
  const changedStory = useMemo(() => storyChangeMarks(test, sourceFile, changedLines), [changedLines, sourceFile, test])

  return (
    <div ref={listing} data-testid="test-presentation">
      <div className="mb-2 flex min-w-0 items-center gap-2 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <TestLanguageSwitch mode={mode} onVisual={() => onModeChange('visual')} onChange={onModeChange} />
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
        {mode === 'code' && definition && <button type="button" className="text-xs text-accent"
          onClick={() => updateInspection({ ...inspection, definition: !inspection.definition })}>{inspection.definition ? 'Call site' : 'Definition'}</button>}
        {mode === 'code' && selectedSource && (
          <button
            type="button"
            className="shrink-0 text-[10px]"
            style={{ color: 'var(--accent)' }}
            onClick={() => { setStorySelection(null); onPick('test') }}
          >
            Full test
          </button>
        )}
      </div>

      {picker}
      {((inspection.section && inspection.section !== section.id) || (inspection.node && !graphNode)) &&
        <p role="status" className="text-xs text-secondary">This selection is unavailable in this source revision.</p>}
      {visual ? <VisualTestView visits={visits} checks={checks} section={section} active={active} test={test.readable} location={runningLocation}
        selected={inspection.box ?? selectedSource?.id} onSelect={selectSource} onHelper={onPick}
        following={!inspection.section} onInspect={() => onPick(section.id)} collapsed={inspection.collapsed}
        onFold={id => { const folds = inspection.collapsed ?? []; updateInspection({ ...inspection, section: section.id,
          collapsed: folds.includes(id) ? folds.filter(f => f !== id) : [...folds, id] }) }} viewport={viewport} fit={!!inspection.fit}
        onFit={fit => updateInspection({ ...inspection, mode, fit, section: section.id })} /> : helper && !section.implementation && !(mode === 'code' && selectedSource) ? (
        <p>This saved flow has no function definition. Open Visual to inspect its recorded steps.</p>
      ) : mode === 'english' ? (
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
              checks={checks}
              test={test.readable}
              sourceFile={sourceFile}
              selectedNodeId={selectedSource?.id}
              executionHighlight={executionStoryNodeId
                ? { kind: executionHighlight?.kind ?? 'running', nodeId: executionStoryNodeId }
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
              checks={code.file === sourceFile ? checks : undefined}
              source={code.source}
              lineHighlight={useLiveLine ? (visualLines?.size ? { kind: 'running', lines: visualLines } : undefined) : executionHighlight && displayedExecutionLines
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
  labels, marks, codeOnly, lang, onVisual, ariaLabel = 'Full test comparison',
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
          ? <TestLanguageSwitch mode={mode} onChange={onModeChange} onVisual={onVisual} />
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
