import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode, CSSProperties } from 'react'
import type { ExtractedTest } from '@shared/extracted-test'
import type { ReaderCall } from '@shared/readable-tests/types'
import type { FlowSection } from '@shared/test-view/flow-layout'
import type { FlowVisit } from '@shared/test-view/flow-execution'
import type { FlowInspection } from '../lib/workspace-view-state'
import { ReaderNavigation } from './ReaderNavigation'
import { Modal } from './Overlays'
import { TestSectionEditor } from './TestReaderEditor'
import { VisualTestView } from './VisualTestView'
import { definitionFor, readerModel, type ReaderStep } from './test-reader-model'
import { useCodeHighlight } from './use-code-highlight'
import { TestLanguageSwitch } from './TestLanguageSwitch'
import { SourceOpenShell } from './TestCodeBlock'

interface Props {
  test: ExtractedTest
  file: string
  sections: FlowSection[]
  section: FlowSection
  inspection: FlowInspection
  change: (state: FlowInspection) => void
  controls?: ReactNode
  visits?: Map<string, FlowVisit>
  checks: ReadonlyMap<number, number>
  active?: string
  execution?: { kind: 'running' | 'failed'; line: number }
  changedLines?: Set<number>
  overviewLabel?: string
  location?: string
}
interface Frame {
  state: FlowInspection
  x: number
  y: number
  section: string
  sourceJump: boolean
}

export function SidebarTestReader({
  test,
  file,
  sections,
  section,
  inspection,
  change,
  controls,
  visits,
  checks,
  active,
  execution,
  changedLines,
  location,
  overviewLabel,
}: Props) {
  const model = useMemo(() => readerModel(test, file, section, sections), [test, file, section, sections])
  const visual = inspection.mode !== 'code',
    full = Boolean(inspection.expanded)
  const mode = visual ? 'visual' : 'code'
  const title = (s: FlowSection) =>
    s.id === 'test'
      ? overviewLabel ?? 'Test overview'
      : definitionFor(s, test.readable)?.name
        ? definitionFor(s, test.readable)!.name + '()'
        : s.label
  const current = inspection.box ?? inspection.node
  const selected = model.stepByBox.get(current ?? '')
  const line = inspection.line ?? selected?.source.startLine
  const graphMemory = useRef<{ left: number; top: number; ancestors: [HTMLElement, number, number][] } | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const trail = useRef<Frame[]>([])
  const restore = useRef<Frame | null>(null)
  const colors = useCodeHighlight('')?.canvas
  function scroller() {
    return host.current?.querySelector<HTMLElement>('.cm-scroller,.cl-flow-sheet')
  }
  function remember(
    line: number | undefined,
    box: string | undefined,
    column: number | undefined,
    sourceJump: boolean
  ) {
    const el = scroller()
    trail.current.push({
      state: { ...inspection, mode, section: section.id, box, line, column },
      x: el?.scrollLeft ?? 0,
      y: el?.scrollTop ?? 0,
      section: section.id,
      sourceJump,
    })
    graphMemory.current = null
  }
  function openCall(call: ReaderCall, box?: string) {
    const owner =
      box ??
      model.steps
        .slice()
        .reverse()
        .find((s) => s.source.startLine === call.line && (s.source.startColumn ?? 1) <= call.column)?.id
    remember(call.line, owner, call.column, false)
    change({ mode, section: call.target, expanded: full })
  }
  function openSource(id: string) {
    const step = model.stepByBox.get(id)
    const box = model.section.topology.boxes.find((b) => b.id === id)
    const sourceLine = step?.source.startLine ?? box?.range?.startLine
    if (!sourceLine) return
    remember(sourceLine, id, undefined, true)
    change({ ...inspection, mode: 'code', section: section.id, box: id, line: sourceLine })
  }
  function pick(step: ReaderStep, source: boolean) {
    if (source) {
      openSource(step.id)
      return
    }
    if (step.helper) {
      const call = model.calls.find((c) => c.target === step.helper && c.line === step.source.startLine)
      openCall(
        call ?? {
          target: step.helper,
          line: step.source.startLine,
          column: step.source.startColumn ?? 1,
          name: step.label,
        },
        step.id
      )
    } else
      change({
        ...inspection,
        mode,
        section: section.id,
        box: step.id,
        node: undefined,
        line: step.source.startLine,
        column: undefined,
      })
  }
  function back() {
    const frame = trail.current.pop()
    graphMemory.current = null
    if (frame) {
      restore.current = frame
      change({ ...frame.state, expanded: full })
      return
    }
    change({ mode, section: section.parent ?? 'test', expanded: full })
  }
  function switchMode(next: 'visual' | 'code') {
    if (next === mode) return
    if (next === 'visual' && trail.current.at(-1)?.sourceJump) {
      back()
      return
    }
    trail.current = trail.current.filter((f) => !f.sourceJump).map((f) => ({ ...f, state: { ...f.state, mode: next } }))
    change({ ...inspection, mode: next, section: section.id })
  }
  useLayoutEffect(() => {
    const el = scroller(),
      f = restore.current
    if (!el || !f) return
    restore.current = null
    const raf = requestAnimationFrame(() => {
      el.scrollTop = f.y
      el.scrollLeft = f.x
      const target = el.querySelector<HTMLElement>(
        '[data-current-call=true], [aria-current=location], [data-current=true] [data-target]'
      )
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [section.id, line, mode, full])
  const activeBox = useMemo(() => {
    if (!active) return
    const boxes = model.section.topology.boxes.filter(box => box.sourceId === active)
    return boxes.length === 1 ? boxes[0] : undefined
  }, [model.section, active])
  const evidence = useCallback(
    (row: { line: number; step?: ReaderStep }) => {
      const visit = row.step && visits?.get(row.step.id)
      const runningBox = activeBox && (visual ? row.step?.id === activeBox.id
        : activeBox.range?.file === model.source.file && activeBox.range.startLine === row.line)
      if (runningBox || (execution?.kind === 'running' && execution.line === row.line))
        return 'Running now'
      if (visit?.failed || (execution?.kind === 'failed' && execution.line === row.line)) return 'Failed'
      if (visit?.completed) return 'Observed ×' + visit.completed
      if (visit?.skipped) return 'Skipped'
    },
    [visits, activeBox, visual, model.source.file, execution?.line, execution?.kind]
  )
  const changed = useCallback(
    (n: number) => section.id === 'test' && !!changedLines?.has(n - (test.bodyLine ?? test.line) + 1),
    [changedLines, section.id, test.bodyLine, test.line]
  )
  const graphReader = useMemo(
    () => ({ stepByBox: model.stepByBox, hints: model.hints, openSource }),
    [model, inspection, section.id]
  )
  const sourcePath =
    model.source.file.split('/').slice(-2).join('/') + ':L' + model.source.startLine + '–' + model.source.endLine
  const tabs = (
    <TestLanguageSwitch
      mode={mode}
      reader={full ? 'expanded' : 'compact'}
      onVisual={() => switchMode('visual')}
      onChange={() => switchMode('code')}
    />
  )
  const nav = (
    <ReaderNavigation title={title(section)} back={trail.current.length > 0 || section.id !== 'test' ? back : undefined}
      expanded={full} fit={inspection.fit} visual={visual}
      onExpand={() => change({ ...inspection, mode, expanded: true })}
      onFit={() => change({ ...inspection, fit: !inspection.fit })}
      onChoose={value => value === 'back' ? back() : model.calls[Number(value)] && openCall(model.calls[Number(value)])}>
      {trail.current.length > 0 && <option value="back">Back to caller</option>}
      {model.calls.length > 0 && <optgroup label="Called here">{model.calls.map((call, index) =>
        <option key={index} value={index}>{call.name}() · L{call.line}</option>)}</optgroup>}
    </ReaderNavigation>
  )
  const reader = (
    <div
      className={'test-reader ' + (full ? 'full' : 'slim')}
      ref={host}
      style={{ '--diagram-bg': colors?.bg, '--diagram-ink': colors?.fg } as CSSProperties}
    >
      <div className={full ? 'dialog-toolbar' : 'modebar mb-2 flex min-w-0 items-center gap-2 border-b pb-2'}>
        {tabs}
        {full ? (
          nav
        ) : (
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-muted" title={sourcePath}>
            {sourcePath}
          </span>
        )}
      </div>
      {!full && nav}
      {controls}
      {visual && full ? (
        <VisualTestView
          test={test.readable}
          section={overviewLabel && section.id === 'test' ? { ...model.section, label: overviewLabel } : model.section}
          reader={graphReader}
          visits={visits}
          checks={checks}
          active={active}
          location={location}
          selected={current}
          following={!inspection.section}
          onInspect={() => change({ ...inspection, mode, section: section.id })}
          onSelect={(target, id) => {
            const step = model.stepByBox.get(id)
            if (step) pick(step, false)
            else change({ ...inspection, mode, box: id, line: target.source.startLine })
          }}
          onHelper={(id, box) => {
            const step = (box && model.stepByBox.get(box)) || model.steps.find((s) => s.helper === id)
            if (step) pick(step, false)
          }}
          viewport={graphMemory}
          collapsed={inspection.collapsed}
          onFold={(id) => {
            const folds = inspection.collapsed ?? []
            change({
              ...inspection,
              mode,
              collapsed: folds.includes(id) ? folds.filter((f) => f !== id) : [...folds, id],
            })
          }}
          fit={!!inspection.fit}
          onFit={(fit) => change({ ...inspection, mode, fit })}
        />
      ) : !visual && !model.source.source ? (
        <p className="text-xs text-muted">Source was not retained for this test.</p>
      ) : visual && !model.steps.length && !model.notes.length ? (
        <button type="button" onClick={() => switchMode('code')}>
          Open source
        </button>
      ) : (
        <SourceOpenShell sourceLocation={{ file: model.source.file, startLine: line ?? model.source.startLine }}>
          <TestSectionEditor
            model={model}
            visual={visual}
            selected={current}
            line={line}
            column={inspection.column}
            evidence={evidence}
            changed={changed}
            onCall={openCall}
            onStep={pick}
          />
        </SourceOpenShell>
      )}
    </div>
  )
  if (!full) return reader
  return (
    <Modal
      open
      portal
      onClose={() => change({ ...inspection, mode, expanded: undefined })}
      title={test.name}
      description={sourcePath}
      ariaLabel="Expanded test reader"
      surfaceClassName="cl-reader-modal"
      testId="expanded-test-reader"
      width={1150}
      viewportInset={2}
      height="var(--test-reader-height)"
      bodyClassName="test-reader-dialog min-h-0 flex-1"
    >
      {reader}
    </Modal>
  )
}
