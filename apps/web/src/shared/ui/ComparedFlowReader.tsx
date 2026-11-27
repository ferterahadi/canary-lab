import { useLayoutEffect, useMemo, useRef, type Ref } from 'react'
import { REVIEW_FILE_SCOPE, reviewCaseKey } from '@shared/test-review'
import type { AlignedReview, TestViewSelection, TestViewSide, TestViewSideLabels } from '@shared/test-view/render-model'
import { changeLabels } from './test-reader-model'
import { combinedFlow, flowEdgeKey, otherSide, reviewReader } from './comparison-flow-model'
import type { ComparisonJump } from '../lib/workspace-view-state'
import { Modal } from './Overlays'
import { ReaderNavigation } from './ReaderNavigation'
import { TestSectionEditor } from './TestReaderEditor'
import { TestLanguageSwitch } from './TestLanguageSwitch'
import { VisualTestView } from './VisualTestView'

type Side = TestViewSide
type Cards = Partial<Record<Side, string>>
interface Props {
  review: AlignedReview
  cards: Cards
  inspection?: ComparisonJump
  labels: TestViewSideLabels
  onInspect: (jump: ComparisonJump) => void
  onSelectSource?: (point: TestViewSelection) => void
  scrollRef?: Ref<HTMLDivElement>
  anchor?: { side: Side; line: number }
  ariaLabel: string
}

export function comparisonCards(
  review: AlignedReview,
  scoped?: Cards,
  inspection?: ComparisonJump,
  anchor?: { side: Side; line: number }
): Cards {
  if (inspection && inspection.flow.card !== REVIEW_FILE_SCOPE) {
    const pair = review.declarationPairs?.find((p) => p[inspection.side] === inspection.flow.card)
    return pair ?? scoped ?? { [inspection.side]: inspection.flow.card }
  }
  if (!inspection && scoped) return scoped
  if (!inspection && anchor) {
    const target = review[anchor.side].tests.find((t) => anchor.line >= t.line && anchor.line <= t.endLine)
    const pair = target && review.declarationPairs?.find((p) => p[anchor.side] === reviewCaseKey(target))
    if (pair) return pair
  }
  return { before: REVIEW_FILE_SCOPE, after: REVIEW_FILE_SCOPE }
}

export function hasComparisonFlow(review: AlignedReview, cards: Cards) {
  return (
    (['before', 'after'] as const).every((side) => {
      const source = review[side],
        card = cards[side]
      if (source.parseError) return false
      if (!card) return !!review.declarationPairs
      if (!source.source && card === REVIEW_FILE_SCOPE) return true
      const graph =
        card === REVIEW_FILE_SCOPE
          ? source.fileFlow?.graph
          : source.tests.find((t) => reviewCaseKey(t) === card)?.readable.graph
      return (
        graph?.schemaVersion === 1 &&
        graph.origin.kind === side &&
        graph.sections[0]?.definition.startOffset != null &&
        graph.sections[0].definition.endOffset != null
      )
    }) && !!(review.before.source || review.after.source)
  )
}

export function ComparedFlowReader({
  review,
  cards,
  inspection,
  labels,
  onInspect,
  onSelectSource,
  scrollRef,
  anchor,
  ariaLabel,
}: Props) {
  const readers = useMemo(
    () => ({
      before: review.before.source ? reviewReader(review.before, 'before', cards.before) : undefined,
      after: review.after.source ? reviewReader(review.after, 'after', cards.after) : undefined,
    }),
    [review.before, review.after, cards.before, cards.after]
  )
  const preferred = inspection?.side ?? 'after'
  const side = readers[preferred] ? preferred : otherSide(preferred)
  const reader = readers[side]!
  const state = inspection?.flow ?? { card: cards[side]!, mode: 'visual' as const }
  const section = reader.sections.find((s) => s.id === state.section) ?? reader.sections[0]
  const combined = useMemo(() => combinedFlow(readers, side, section), [readers, side, section])
  const { model, sources, models } = combined
  const revision = models[side]!
  const expanded = !!state.expanded,
    visual = state.mode !== 'code'
  const memory = useRef<{ left: number; top: number; ancestors: [HTMLElement, number, number][] } | null>(null)
  const trail = useRef<{ jump: ComparisonJump; top: number; left: number }[]>([])
  const host = useRef<HTMLDivElement>(null)
  const restore = useRef<{ top: number; left: number } | null>(null)
  const current = state.box
  const scroller = () => host.current?.querySelector<HTMLElement>('.cm-scroller,.cl-flow-sheet')
  const update = (changes: Partial<typeof state>, owner = side) =>
    onInspect({ side: owner, flow: { ...state, ...changes, card: cards[owner]!, combined: true } })
  function remember(id?: string) {
    const el = scroller()
    trail.current.push({
      jump: { side, flow: { ...state, box: id ?? state.box, combined: true } },
      top: el?.scrollTop ?? 0,
      left: el?.scrollLeft ?? 0,
    })
    memory.current = null
  }
  function back() {
    const saved = trail.current.pop()
    memory.current = null
    if (saved) {
      restore.current = saved
      onInspect({ ...saved.jump, flow: { ...saved.jump.flow, expanded } })
    } else update({ section: undefined, box: undefined, line: undefined, mode: 'visual' })
  }
  useLayoutEffect(() => {
    const el = scroller(),
      pos = restore.current
    if (!el || !pos) return
    el.scrollTop = pos.top
    el.scrollLeft = pos.left
    restore.current = null
    el.querySelector<HTMLElement>('[aria-current=location],[data-current=true] [data-target]')?.focus({
      preventScroll: true,
    })
  }, [section, visual, expanded, current])
  useLayoutEffect(() => {
    if (!anchor || inspection) return
    const el = host.current?.querySelector<HTMLElement>(
      '[data-side="' + anchor.side + '"][data-source-line="' + anchor.line + '"]'
    )
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [model, anchor?.side, anchor?.line, inspection])
  function pick(id: string, source: boolean) {
    const point = sources.get(id)
    if (!point) return
    const { step, side: owner } = point
    if (source && !expanded && section.id === 'test' && onSelectSource) {
      onSelectSource({ side: owner, line: step.source.startLine, endLine: step.source.endLine })
      return
    }
    if (source || step.helper) {
      remember(id)
      update(
        {
          mode: source ? 'code' : 'visual',
          section: source ? point.section : step.helper,
          box: source ? id : undefined,
          line: source ? step.source.startLine : undefined,
          column: undefined,
        },
        owner
      )
    } else update({ box: id, line: step.source.startLine })
  }
  const graphReader = { stepByBox: model.stepByBox, hints: model.hints, openSource: (id: string) => pick(id, true) }
  const comparison = useMemo(
    () => ({
      captions: new Map(
        model.steps
          .filter((s) => s.change)
          .map((s) => [s.id, changeLabels[s.change!.kind] + ' ' + (s.change!.detail ?? '')])
      ),
      edgeSide: (e: Parameters<typeof flowEdgeKey>[0]) => combined.origins.get(flowEdgeKey(e)),
    }),
    [combined, model]
  )
  const title =
    section.id === 'test' ? (cards[side] === REVIEW_FILE_SCOPE ? 'File overview' : 'Test overview') : section.label
  const nav = (
    <ReaderNavigation
      title={title}
      back={trail.current.length || section.id !== 'test' ? back : undefined}
      visual={visual}
      expanded={expanded}
      fit={state.fit}
      onFit={() => update({ fit: !state.fit })}
      onExpand={() => update({ expanded: true })}
      onChoose={(value) => {
        memory.current = null
        if (value === 'file') {
          trail.current = []
          onInspect({ side, flow: { card: REVIEW_FILE_SCOPE, mode: 'visual', expanded, combined: true } })
        } else if (value.startsWith('call:')) {
          const call = revision.calls[Number(value.slice(5))]
          if (call) {
            remember()
            update({ section: call.target, line: undefined, box: undefined })
          }
        } else {
          const pair = review.declarationPairs?.[Number(value.slice(5))]
          const owner = pair?.after ? 'after' : 'before'
          if (pair) {
            trail.current = []
            onInspect({ side: owner, flow: { card: pair[owner]!, mode: 'visual', expanded, combined: true } })
          }
        }
      }}
    >
      {cards[side] !== REVIEW_FILE_SCOPE && review[side].fileFlow && <option value="file">File overview</option>}
      {!!review.declarationPairs?.length && (
        <optgroup label="Tests">
          {review.declarationPairs.map((p, i) => {
            const key = p.after ?? p.before!
            return (
              <option key={i} value={'case:' + i}>
                {key.slice(key.indexOf(':') + 1)}
              </option>
            )
          })}
        </optgroup>
      )}
      {revision.calls.length > 0 && (
        <optgroup label="Called here">
          {revision.calls.map((call, i) => (
            <option key={i} value={'call:' + i}>
              {call.name}() · L{call.line}
            </option>
          ))}
        </optgroup>
      )}
    </ReaderNavigation>
  )
  const tabs = (
    <TestLanguageSwitch
      mode={visual ? 'visual' : 'code'}
      reader={expanded ? 'expanded' : 'compact'}
      onVisual={() => update({ mode: 'visual' })}
      onChange={() => update({ mode: 'code' })}
    />
  )
  const body = (
    <div ref={host} className={'test-reader comparison-flow ' + (expanded ? 'full' : 'slim')}>
      <div className={expanded ? 'dialog-toolbar' : 'comparison-toolbar'}>
        {(expanded || !visual) && tabs}
        {nav}
        <span className="revision-pair">
          {labels.before} → {labels.after}
        </span>
      </div>
      {visual && expanded ? (
        <VisualTestView
          test={reader.test.readable}
          section={{ ...model.section, label: title }}
          reader={graphReader}
          comparison={comparison}
          checks={new Map()}
          selected={current}
          following={false}
          onInspect={() => {}}
          viewport={memory}
          onFold={() => {}}
          fit={!!state.fit}
          onFit={(fit) => update({ fit })}
          onSelect={(_, id) => pick(id, false)}
          onHelper={(_, id) => {
            if (id) pick(id, false)
          }}
        />
      ) : (
        <TestSectionEditor
          model={visual ? model : revision}
          visual={visual}
          selected={current}
          line={state.line}
          onStep={(step, source) => pick(step.id, source)}
          onCall={(call) => {
            remember()
            update({ section: call.target, line: undefined, box: undefined })
          }}
        />
      )}
      {combined.peerUnavailable && (
        <p role="status" className="text-xs text-secondary">
          A matching helper definition was unavailable in the other revision.
        </p>
      )}
      {expanded && visual && combined.origins.size > 0 && (
        <div className="comparison-edge-key">
          <span>{labels.after} only</span>
          <span>{labels.before} only</span>
        </div>
      )}
    </div>
  )
  return (
    <div className="cl-combined-review" data-format={visual ? 'visual' : 'code'} role="group" aria-label={ariaLabel} ref={scrollRef}>
      {expanded ? (
        <Modal
          open
          portal
          onClose={() => update({ expanded: undefined })}
          title={reader.test.name}
          description={revision.source.file}
          ariaLabel="Expanded test reader"
          surfaceClassName="cl-reader-modal"
          testId="expanded-test-reader"
          width={1150}
          viewportInset={2}
          height="var(--test-reader-height)"
          bodyClassName="test-reader-dialog min-h-0 flex-1"
        >
          {body}
        </Modal>
      ) : (
        body
      )}
    </div>
  )
}
