import { useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Decoration, EditorView } from '@codemirror/view'
import { type Range } from '@codemirror/state'
import { comparisonPatchRows } from '@shared/comparison-patch'
import { compareText } from '@shared/lib/comparison-diff'
import { plural } from '@shared/lib/plural'
import type { ContextRow } from '@shared/test-source-diff'
import { REVIEW_FILE_SCOPE, reviewCaseKey, type ReviewSource } from '@shared/test-review'
import {
  alignedTestViewRows,
  type AlignedReview,
  type TestViewSelection,
  type TestViewSide,
  type TestViewSideLabels,
} from '@shared/test-view/render-model'
import { flowSections, sectionNodes } from '@shared/test-view/flow-layout'
import type { CardInspection, ComparisonJump } from '../lib/workspace-view-state'
import { readerLabelMarks } from './reader-editor-view'
import { stepIcons, TestReaderEditor } from './TestReaderEditor'
import { ComparedFlowReader, comparisonCards, hasComparisonFlow } from './ComparedFlowReader'
import { ReaderNavigation } from './ReaderNavigation'
import type { CodeLanguage } from './code-highlighter'

interface Props {
  review: AlignedReview
  inspection?: ComparisonJump
  rows: ContextRow[]
  visual: boolean
  labels: TestViewSideLabels
  change?: number
  marks?: 'line' | 'word'
  selection?: TestViewSelection | null
  onSelectSource?: (point: TestViewSelection) => void
  onInspect?: (jump: ComparisonJump) => void
  onReturn?: () => void
  returnSelection?: TestViewSelection
  scopedCase?: Partial<Record<TestViewSide, string>>
  emptySide?: TestViewSide
  emptySideLabel?: string
  ariaLabel: string
  lang?: CodeLanguage
  anchor?: { side: TestViewSide; line: number }
  scrollRef?: Ref<HTMLDivElement>
}

interface CompareLine {
  text: string
  number?: string
  source?: number
  syntaxLine?: number
  end?: number
  changed?: boolean
  edit?: boolean
  selected?: boolean
  kind?: keyof typeof stepIcons | 'note'
  depth?: number
  words?: readonly { text: string; changed: boolean }[]
  links?: { from: number; to: number; jump: CardInspection }[]
  gap?: boolean
  absent?: boolean
}

function sourceIndex(source: ReviewSource) {
  const labels = new Map<number, string>()
  const calls = new Map<number, { column: number; name: string; direct?: boolean; jump: CardInspection }[]>()
  const scopes = source.tests.map(test => ({ card: reviewCaseKey(test), readable: test.readable }))
  if (source.fileFlow) scopes.unshift({ card: REVIEW_FILE_SCOPE, readable: source.fileFlow })
  for (const { card, readable } of scopes) {
    const root = flowSections(readable.nodes, readable.graph)[0]
    for (const node of sectionNodes(root)) {
      if (node.flow) labels.set(node.source.startLine, node.flow.caption ?? node.flow.label)
    }
    for (const call of readable.navigation?.calls ?? []) {
      const row = calls.get(call.line) ?? []
      const duplicate = row.findIndex(link => link.column === call.column && link.name === call.name)
      if (duplicate !== -1) row.splice(duplicate, 1)
      row.push({ ...call, jump: { card, mode: 'visual', section: call.target } })
      calls.set(call.line, row)
    }
  }
  return { labels, calls }
}

function comparisonLines(props: Props): Record<TestViewSide, CompareLine[]> {
  const { review, visual } = props
  const shown = (source: ReviewSource) => (source.outline && visual ? { ...source, story: source.outline } : source)
  const aligned = alignedTestViewRows({
    ...props,
    review: { ...review, before: shown(review.before), after: shown(review.after) },
    mode: visual ? 'english' : 'code',
  })
  const indexes = { before: sourceIndex(review.before), after: sourceIndex(review.after) }
  const result: Record<TestViewSide, CompareLine[]> = { before: [], after: [] }
  for (const pair of aligned) {
    for (const side of ['before', 'after'] as const) {
      const gap = pair.source.gap
      if (gap) result[side].push({ text: plural(gap[side], 'unchanged line') + ' not in this patch', gap: true })
    }
    const count = visual ? Math.max(1, pair.before?.english?.length ?? 0, pair.after?.english?.length ?? 0) : 1
    for (let n = 0; n < count; ++n)
      for (const side of ['before', 'after'] as const) {
        const cell = pair[side]
        if (!cell || cell.continued || (n > 0 && !cell.english?.[n])) {
          const absent = !cell && props.emptySide === side && pair.source === props.rows[0] && n === 0
          result[side].push({
            absent,
            text: absent
              ? (props.emptySideLabel ??
                (side === 'before' ? 'Not present in recorded tests' : 'Removed from current source'))
              : '',
          })
          continue
        }
        const step = cell.english?.[n]?.step
        const isNote = step?.role === 'note'
        const calls = indexes[side].calls.get(cell.sourceLine) ?? []
        const text =
          visual && step
            ? (isNote ? step.source.snippet : (indexes[side].labels.get(cell.sourceLine) ?? step.text))
                .replace(/\s+/g, ' ')
                .trim()
            : cell.code
        const links: NonNullable<CompareLine['links']> = []
        if (props.onInspect) {
          if (visual) {
            const direct = calls.filter(
              (call) =>
                call.direct &&
                call.column >= (step?.source.startColumn ?? 1) &&
                (step?.source.endLine !== cell.sourceLine || call.column < (step.source.endColumn ?? Infinity)),
            )
            const helper = direct.length === 1 ? direct[0] : undefined
            if (helper && text && !isNote && step?.role !== 'test')
              links.push({ from: 0, to: text.length, jump: helper.jump })
          } else
            for (const call of calls) {
              const from = call.column - 1
              if (text.slice(from, from + call.name.length) === call.name)
                links.push({ from, to: from + call.name.length, jump: { ...call.jump, mode: 'code' } })
            }
        }
        result[side].push({
          text,
          source: cell.sourceLine,
          end: cell.endLine,
          number: cell.label,
          edit: pair.selected,
          changed: cell.marks.changed,
          selected: cell.marks.selected,
          words: visual ? undefined : cell.marks.words,
          kind: visual && step ? (isNote ? 'note' : links.length ? 'helper' : step.role === 'check' ? 'check'
            : step.kind === 'flow' && ['condition', 'loop', 'switch'].includes(step.flowKind) ? 'decision' : 'action') : undefined,
          depth: cell.english?.[n]?.depth,
          links,
        })
      }
  }
  return result
}

function RevisionEditor({ side, lines, props }: { side: TestViewSide; lines: CompareLine[]; props: Props }) {
  const { visual, labels, lang, review } = props
  const editor = useRef<EditorView | null>(null)
  const [picked, setPicked] = useState<number>()
  const back = props.returnSelection
  const handlers = useRef(props)
  handlers.current = props
  const extensions = useMemo(() => {
    const ranges: Range<Decoration>[] = []
    const jumps: CardInspection[] = []
    let at = 0
    for (const [index, row] of lines.entries()) {
      const attrs: Record<string, string> = {
        'data-side': side,
        'data-ref': row.number ?? '',
        'data-index': String(index),
      }
      if (visual && row.source === picked && row.kind) attrs['data-current'] = 'true'
      if (row.source != null) attrs['data-source-line'] = String(row.source)
      if (row.edit) attrs['data-selected'] = 'true'
      if (row.changed) attrs['data-change'] = side === 'before' ? 'removed' : 'added'
      if (row.selected) attrs['data-source-selected'] = 'true'
      if (row.kind) {
        attrs['data-kind'] = row.kind
        attrs['data-ref'] = 'L' + row.number
        if (row.kind !== 'note') {
          attrs['data-outline-box'] = String(index)
          attrs['data-icon'] = stepIcons[row.kind]
          attrs.style = '--depth:' + Math.min(3, row.depth ?? 0)
        }
      }
      if (row.gap) attrs['data-gap'] = 'true'
      if (row.absent) attrs.class = 'cl-comparison-empty'
      if (row.end != null) attrs['data-source-end-line'] = String(row.end)
      if (row.text) attrs.title = row.text
      if (visual && row.source && handlers.current.onSelectSource) {
        attrs.tabindex = '0'
        attrs.title = row.text + ' · ⌘-click to open code at line ' + row.source
      } else if (
        !visual &&
        row.source &&
        back?.side === side &&
        row.source >= back.line &&
        row.source <= back.endLine
      ) {
        attrs.tabindex = '0'
        attrs['data-return-to-visual'] = 'true'
        attrs.title = 'Return to Visual at line ' + back.line
      } else if (row.selected) attrs.tabindex = '-1'
      ranges.push(Decoration.line({ attributes: attrs }).range(at))
      if (visual && row.kind !== 'note') ranges.push(...readerLabelMarks(row.text, at))
      let wordAt = at
      for (const part of row.words ?? []) {
        if (part.changed && part.text)
          ranges.push(
            Decoration.mark({ tagName: 'mark', class: 'cl-review-word' }).range(wordAt, wordAt + part.text.length),
          )
        wordAt += part.text.length
      }
      for (const link of row.links ?? []) {
        const id = jumps.push(link.jump) - 1
        ranges.push(
          Decoration.mark({
            class: visual ? 'outline-label' : 'source-call',
            attributes: {
              'data-jump': String(id),
              tabindex: '0',
              role: 'link',
              'aria-label': 'Open definition · ' + row.text.slice(link.from, link.to),
            },
          }).range(at + link.from, at + link.to),
        )
      }
      at += row.text.length + 1
    }
    function activate(event: MouseEvent | KeyboardEvent) {
      const target = event.target as HTMLElement
      const el = target.closest<HTMLElement>('.cm-line')
      if (!el) return false
      const row = lines[Number(el.dataset.index)]
      if (!row?.source) return false
      const jump = target.closest<HTMLElement>('[data-jump]')?.dataset.jump
      if (visual && (event.metaKey || event.ctrlKey))
        handlers.current.onSelectSource?.({ side, line: row.source, endLine: row.end ?? row.source })
      else if (jump != null) handlers.current.onInspect?.({ side, flow: jumps[Number(jump)] })
      else if (!visual && el.hasAttribute('data-return-to-visual')) handlers.current.onReturn?.()
      else if (visual) setPicked(row.source)
      else return false
      event.preventDefault()
      return true
    }
    return [
      EditorView.decorations.of(Decoration.set(ranges, true)),
      EditorView.domEventHandlers({ click: activate, keydown: (e) => e.key === 'Enter' && activate(e) }),
    ]
  }, [lines, visual, side, back, picked])
  const sourceLines = useMemo(() => lines.map(row => row.syntaxLine ?? row.source), [lines])
  useLayoutEffect(() => {
    const view = editor.current
    const pane = view?.dom.closest<HTMLElement>('.cl-file-comparison')
    const target = props.selection ?? props.anchor
    if (!view || !pane || (target && target.side !== side)) return
    const index = target
      ? lines.findIndex(
          (row) => row.source !== undefined && row.source <= target.line && (row.end ?? row.source) >= target.line,
        )
      : lines.findIndex((row) => row.edit)
    if (index < 0 || view.contentDOM.querySelector('[data-index="' + index + '"]')) return
    // A distant edit has no DOM row yet. Both columns use one fixed-height
    // row per pair; CodeMirror's startup estimate may precede font measurement.
    const frame = requestAnimationFrame(() => {
      const first = view.contentDOM.querySelector<HTMLElement>('.cm-line')
      if (!first) return
      const rowHeight = first.getBoundingClientRect().height
      pane.scrollTop += view.contentDOM.getBoundingClientRect().top - pane.getBoundingClientRect().top
        + index * rowHeight - pane.clientHeight / 3
      view.requestMeasure()
    })
    return () => cancelAnimationFrame(frame)
  }, [lines, props.selection, props.anchor?.line, props.anchor?.side, side])
  return <TestReaderEditor editorRef={editor} doc={lines.map(row => row.text).join('\n')} visual={visual}
    label={labels[side] + (visual ? ' visual outline' : ' code')} extensions={extensions}
    sourceLines={sourceLines} syntaxSource={review[side].source} lang={lang} className="cl-comparison-reader-pane" />
}

export function FileComparisonEditor(props: Props) {
  const [localInspection, setLocalInspection] = useState<ComparisonJump>()
  const { review } = props
  const inspection = props.onInspect ? props.inspection : localInspection
  const edit = props.change == null ? props.rows.find(row => row.before !== row.after) : props.rows.find(row => row.change === props.change)
  const anchor = props.anchor ?? (edit?.afterLine ? {side:'after' as const,line:edit.afterLine}
    : edit?.beforeLine ? {side:'before' as const,line:edit.beforeLine} : undefined)
  const cards = comparisonCards(review, props.scopedCase, inspection, anchor)
  if ((props.visual || props.inspection?.flow.combined) && hasComparisonFlow(review,cards))
    return <ComparedFlowReader key={JSON.stringify([cards.before,cards.after])} {...props} cards={cards} anchor={anchor} inspection={inspection} onInspect={props.onInspect ?? setLocalInspection}/>
  return <AlignedFileEditor {...props}/>
}

function AlignedFileEditor(props: Props) {
  const { rows, review, change, marks, selection, visual, emptySide, emptySideLabel, onInspect } = props
  const canInspect = !!onInspect
  const lines = useMemo(
    () => comparisonLines(props),
    [rows, review, change, marks, selection, visual, emptySide, emptySideLabel, canInspect],
  )
  return <ComparisonSurface props={props} lines={lines} />
}

/** Raw patches contain hunk and file headers, and may omit every unchanged
 * line. Keep those boundaries without assigning synthetic file line numbers. */
export function CapturedPatchEditor({ diff }: { diff: string }) {
  const { lines, review } = useMemo(() => {
    const lines: Record<TestViewSide, CompareLine[]> = { before: [], after: [] }
    const source = { before: [] as string[], after: [] as string[] }
    for (const row of comparisonPatchRows(diff)) {
      const words = row.kind === 'values' && row.before !== null && row.after !== null && row.before !== row.after
        ? compareText(row.before, row.after) : undefined
      for (const side of ['before', 'after'] as const) {
        if (row.kind === 'section') {
          lines[side].push({ text: row.text, gap: true })
          source[side].push('')
        } else {
          const text = row[side] ?? ''
          const syntaxLine = source[side].push(text)
          lines[side].push({ text, syntaxLine, changed: row[side] !== null && row.before !== row.after, words: words?.[side] })
        }
      }
    }
    const review = { before: { source: source.before.join('\n'), tests: [] }, after: { source: source.after.join('\n'), tests: [] } }
    return { lines, review }
  }, [diff])
  return <ComparisonSurface props={{ review, rows: [], visual: false, labels: { before: 'Before', after: 'After' },
    ariaLabel: 'Patch before and after' }} lines={lines} />
}

function ComparisonSurface({ props, lines }: { props: Props; lines: Record<TestViewSide, CompareLine[]> }) {
  const { visual } = props
  return (
    <div
      ref={props.scrollRef}
      className="cl-file-comparison"
      role="group"
      aria-label={props.ariaLabel}
      data-format={visual ? 'visual' : 'code'}
    >
      <div className="cl-comparison-reader-head">
        {(['before', 'after'] as const).map((side) => (
          <div key={side} className="test-reader slim cl-revision-head" role="group" aria-label={props.labels[side]}>
            <h3>{props.labels[side]}</h3>
            <RevisionNavigation side={side} {...props} />
          </div>
        ))}
      </div>
      <div className="cl-comparison-reader-columns test-reader slim" style={{ minHeight: `max(calc(100% - 34px), calc(${lines.before.length} * var(--review-row-height) + 8px))` }}>
        {(['before', 'after'] as const).map((side) => (
          <RevisionEditor key={side} props={props} side={side} lines={lines[side]} />
        ))}
      </div>
    </div>
  )
}

function RevisionNavigation({ side, review, scopedCase, onInspect, visual, emptySide }: Props & { side: TestViewSide }) {
  const source = review[side]
  if (!onInspect || emptySide === side) return null
  const scopes = source.tests.filter(test => test.readable.graph?.origin.kind === side)
  const test = scopes.find(test => reviewCaseKey(test) === scopedCase?.[side])
  const file = source.fileFlow?.graph?.origin.kind === side ? source.fileFlow : undefined
  const current = test ?? (!file ? scopes[0] : undefined)
  if (!file && !current) return null
  const card = current ? reviewCaseKey(current) : REVIEW_FILE_SCOPE
  const calls = (current?.readable ?? file)?.navigation?.calls ?? []
  const mode = visual ? 'visual' : 'code'
  return <ReaderNavigation title={current ? 'Test overview' : 'File overview'} visual={visual}
    onExpand={() => onInspect({ side, flow: { card, mode, expanded: true, returnToFile: true } })}
    onChoose={value => {
      if (value.startsWith('call:')) {
        const call = calls[Number(value.slice(5))]
        if (call) onInspect({ side, flow: { card, mode, section: call.target } })
      } else onInspect({ side, flow: { card: value, mode } })
    }}>
    {scopes.length > 0 && <optgroup label="Tests">{scopes.map(test =>
      <option key={reviewCaseKey(test)} value={reviewCaseKey(test)}>{test.name} · L{test.line}</option>)}</optgroup>}
    {calls.length > 0 && <optgroup label="Called here">{calls.map((call, i) =>
      <option key={i} value={'call:' + i}>{call.name}() · L{call.line}</option>)}</optgroup>}
  </ReaderNavigation>
}
