import './test-reader.css'
import { useLayoutEffect, useMemo, useRef, type CSSProperties, type RefObject } from 'react'
import { Compartment, type Range, type Extension } from '@codemirror/state'
import { Decoration, EditorView, lineNumbers } from '@codemirror/view'
import { createReaderEditor, readerLabelMarks, readerSyntaxMarks } from './reader-editor-view'
import type { ReaderCall } from '@shared/readable-tests/types'
import type { ReaderModel, ReaderStep } from './test-reader-model'
import { changeLabels } from './test-reader-model'
import type { CodeLanguage } from './code-highlighter'
import { useCodeHighlight } from './use-code-highlight'

type Link = { from: number; to: number; call: ReaderCall }
type Row = {
  text: string
  line: number
  column?: number
  step?: ReaderStep
  note?: boolean
  continuation?: boolean
  links?: Link[]
}
function editorRows(model: ReaderModel, visual: boolean): Row[] {
  if (visual) {
    const notes = model.notes.flatMap(({ item }) =>
      item.source.snippet.split(/\r?\n/).map((line, i) => ({
        text: line.trimStart(),
        line: item.source.startLine + i,
        column: i ? 1 : item.source.startColumn,
        note: true,
        continuation: i > 0,
      })),
    )
    return [
      ...model.steps.map((step) => ({
        text: step.label + (step.change ? '  ' + changeLabels[step.change.kind] + (step.change.detail ? ' · ' + step.change.detail : '') : ''),
        line: step.source.startLine,
        column: step.source.startColumn,
        step,
      })),
      ...notes,
    ].sort((a: Row, b: Row) => (a.step?.order ?? a.line) - (b.step?.order ?? b.line) || (a.step?.order != null && b.step?.order != null ? 0 : (a.column ?? 1) - (b.column ?? 1)))
  }
  return model.source.source.split('\n').map((text, i) => {
    const { sourceLine: line, sourceLines } = model.source.lineMap[i] ?? { sourceLine: 0, sourceLines: [] }
    const links: Link[] = []
    for (const call of model.calls.filter((c) => sourceLines.includes(c.line))) {
      const from =
        call.contentColumn == null
          ? text.indexOf(call.name + '(')
          : text.length - text.trimStart().length + call.contentColumn
      if (from >= 0 && text.slice(from, from + call.name.length) === call.name)
        links.push({ from, to: from + call.name.length, call })
    }
    return { text, line, links }
  })
}

export const stepIcons = { helper: 'ƒ', check: '✓', decision: '◇', action: '▭' }

/** Both single and paired readers mount this surface. Comparison adapters supply
 * aligned rows and their original line numbers for multiline syntax tokens. */
export function TestReaderEditor({ doc, visual, label, extensions, focusAt, syntaxSource = doc, sourceLines,
  lang, editorRef, className = '' }: {
  doc: string; visual: boolean; label: string; extensions: Extension[]; focusAt?: number
  syntaxSource?: string; sourceLines?: readonly (number | undefined)[]; lang?: CodeLanguage
  editorRef?: RefObject<EditorView | null>; className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const local = useRef<EditorView | null>(null)
  const editor = editorRef ?? local
  const layer = useMemo(() => new Compartment(), [])
  const syntax = useCodeHighlight(visual ? '' : syntaxSource, lang)
  useLayoutEffect(() => {
    if (!host.current) return
    const view = createReaderEditor(host.current, doc, label, [...extensions, layer.of([])])
    editor.current = view
    if (focusAt != null) view.dispatch({ selection: { anchor: focusAt }, effects: EditorView.scrollIntoView(focusAt, { y: 'center' }) })
    return () => { editor.current = null; view.destroy() }
  }, [doc, label, extensions, focusAt, editor, layer])
  useLayoutEffect(() => {
    const view = editor.current
    if (!view || visual || !syntax) return
    const marks: Range<Decoration>[] = []
    for (let i = 0; i < view.state.doc.lines; i++) {
      const n = sourceLines ? sourceLines[i] : i + 1
      const html = n && syntax.lines[n - 1]
      if (html) marks.push(...readerSyntaxMarks(html, view.state.doc.line(i + 1).from))
    }
    view.dispatch({ effects: layer.reconfigure(EditorView.decorations.of(Decoration.set(marks, true))) })
  }, [editor, layer, doc, label, extensions, focusAt, visual, sourceLines, syntax])
  return <div ref={host} className={`text-editor ${visual ? 'outline-editor' : 'source-editor'} ${className}`}
    style={{ '--source-bg': syntax?.canvas.bg, '--source-fg': syntax?.canvas.fg,
      '--source-comment': syntax?.canvas.comment } as CSSProperties} />
}

interface Props {
  model: ReaderModel
  visual: boolean
  selected?: string
  line?: number
  column?: number
  evidence?: (row: Row) => string | undefined
  changed?: (line: number) => boolean
  onStep: (step: ReaderStep, source: boolean) => void
  onCall: (call: ReaderCall) => void
}
export function TestSectionEditor(props: Props) {
  const { model, visual, selected, line, column, evidence, changed } = props
  const rows = useMemo(() => editorRows(model, visual), [model, visual])
  const doc = useMemo(() => rows.map((r) => r.text).join('\n'), [rows])
  const callbacks = useRef(props)
  callbacks.current = props
  const { extensions, focusAt } = useMemo(() => {
    const ranges: Range<Decoration>[] = []
    const actions: ((source: boolean) => void)[] = []
    let at = 0,
      focusAt: number | undefined
    for (const row of rows) {
      const step = row.step
      const current = visual ? step && selected === step.id : line === row.line
      const state = evidence?.(row)
      const attrs: Record<string, string> = {
        'data-source-line': String(row.line),
        'data-current': String(Boolean(current)),
      }
      if (state) attrs['data-evidence'] = state
      if (changed?.(row.line)) attrs['data-changed'] = 'true'
      if (current && focusAt == null) focusAt = at
      if (step) {
        const target = String(actions.push((source) => callbacks.current.onStep(step, source)) - 1)
        Object.assign(attrs, {
          'data-outline-box': step.id,
          'data-target': target,
          'data-kind': step.kind,
          'data-icon': stepIcons[step.kind],
          'data-ref': 'L' + row.line,
          style: '--depth:' + Math.min(3, step.depth),
        })
        if (step.change) {
          attrs['data-diff'] = step.change.kind
          ranges.push(Decoration.mark({ class: 'reader-change', attributes: { 'data-diff': step.change.kind } })
            .range(at + step.label.length + 2, at + row.text.length))
        }
        if (step.side) attrs['data-side'] = step.side
        if (step.label)
          ranges.push(
            Decoration.mark({
              class: 'outline-label',
              attributes: {
                'data-target': target,
                tabindex: '0',
                role: step.helper ? 'link' : 'button',
                'aria-label': row.text + ' · L' + row.line,
                title: step.label + ' · ⌘-click for Code',
              },
            }).range(at, at + step.label.length),
          )
        ranges.push(...readerLabelMarks(step.label, at))
      } else if (row.note) {
        Object.assign(attrs, {
          'data-kind': 'note',
          'data-ref': 'L' + row.line,
          'data-continuation': String(!!row.continuation),
        })
      } else
        for (const { from, to, call } of row.links ?? []) {
          const target = String(actions.push(() => callbacks.current.onCall(call)) - 1)
          const focusCall = current && call.column === column
          if (focusCall) focusAt = at + from
          ranges.push(
            Decoration.mark({
              class: 'source-call',
              attributes: {
                'data-target': target,
                'data-current-call': String(!!focusCall),
                tabindex: '0',
                role: 'link',
                'aria-label': 'Open ' + call.name + ' definition from line ' + call.line,
              },
            }).range(at + from, at + to),
          )
        }
      ranges.push(Decoration.line({ attributes: attrs }).range(at))
      at += row.text.length + 1
    }
    let pressed: { target?: string; x: number; y: number } | undefined
    const target = (event: Event) => (event.target as Element).closest<HTMLElement>('[data-target]')?.dataset.target
    const extensions = [
      EditorView.lineWrapping,
      EditorView.decorations.of(Decoration.set(ranges, true)),
      ...(visual ? [] : [lineNumbers({ formatNumber: (n) => String(rows[n - 1]?.line || '') })]),
      EditorView.domEventHandlers({
        mousedown(e) {
          pressed = { target: target(e), x: e.clientX, y: e.clientY }
          return false
        },
        click(e) {
          const press = pressed
          pressed = undefined
          if (e.button || e.shiftKey || (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4))
            return false
          const id = press?.target ?? target(e)
          if (id == null) return false
          actions[Number(id)](e.metaKey || e.ctrlKey)
          return true
        },
        keydown(e) {
          const id = target(e)
          if (id == null || e.key !== 'Enter') return false
          e.preventDefault()
          actions[Number(id)](e.metaKey || e.ctrlKey)
          return true
        },
      }),
    ]
    return { extensions, focusAt }
  }, [rows, visual, line, column, selected, evidence, changed])
  return <TestReaderEditor doc={doc} visual={visual} label={visual ? 'Visual outline' : 'Test source'}
    extensions={extensions} focusAt={focusAt} />
}
