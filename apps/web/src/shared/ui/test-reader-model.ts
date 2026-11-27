import type { ExtractedTest } from '@shared/extracted-test'
import type { ReaderCall, ReadableNode, ReadableSource, ReadableTest } from '@shared/readable-tests/types'
import { readableStorySequenceEntries } from '@shared/readable-tests/story-source-map'
import { buildFlowTopology } from '@shared/test-view/flow-graph'
import { sectionNodes, type FlowSection } from '@shared/test-view/flow-layout'
import { testViewSource } from '@shared/test-view/render-model'

export function definitionFor(section: FlowSection, test: ReadableTest) {
  const range = section.implementation?.source
  return test.navigation?.definitions.find(
    (d) => d.id === section.id || (range && d.source.file === range.file && d.bodyOffset === range.startOffset)
  )
}

export function readerSections(sections: FlowSection[], test: ReadableTest): FlowSection[] {
  const result = [...sections]
  for (const def of test.navigation?.definitions ?? []) {
    const existing = sections.find(
      (s) => s.implementation?.source.file === def.source.file && s.implementation.source.startOffset === def.bodyOffset
    )
    result.push({
      id: def.id,
      label: def.name + '()',
      nodes: existing?.nodes ?? def.nodes ?? [],
      implementation: { source: def.source, story: existing?.implementation?.story ?? def.story ?? { steps: [] } },
    })
  }
  return result
}

export const changeLabels = {
  added: '+ Added',
  removed: '− Removed',
  modified: '~ Modified',
  inside: '↳ Changed inside',
}
export type StepChange = { kind: keyof typeof changeLabels; detail?: string }

export interface ReaderStep {
  change?: StepChange
  side?: 'before' | 'after'
  order?: number
  id: string
  source: ReadableSource
  label: string
  kind: 'check' | 'action' | 'helper' | 'decision'
  helper?: string
  depth: number
}

export function readerModel(test: ExtractedTest, file: string, section: FlowSection, sections: FlowSection[]) {
  const def = definitionFor(section, test.readable)
  const definition = def?.source ?? section.implementation?.source
  const source = definition
    ? {
        file: definition.file,
        startLine: definition.startLine,
        endLine: definition.endLine,
        source: definition.snippet,
        lineMap: definition.snippet
          .split('\n')
          .map((_, i) => ({ sourceLine: definition.startLine + i, sourceLines: [definition.startLine + i] })),
      }
    : section.id !== 'test'
      ? { file, startLine: 0, endLine: 0, source: '', lineMap: [] }
      : testViewSource(test.readable.navigation ? { ...test, codeDisplay: undefined } : test, file)
  const nodes = sectionNodes(section)
  const children = sections.filter((s) => s.parent === section.id)
  function callTarget(call: ReaderCall) {
    const child = children.find((s) => {
      const n = nodes.find((n) => n.id === s.id)
      return n?.source.startLine === call.line && definitionFor(s, test.readable)?.id === call.target
    })
    return { ...call, target: child?.id ?? call.target }
  }
  const savedCalls = section.id === 'test' ? test.readable.navigation?.calls : def?.calls
  const calls: ReaderCall[] =
    savedCalls?.map(callTarget) ??
    children.flatMap((child) => {
      const n = nodes.find((n) => n.id === child.id)
      const match = n?.source.snippet.match(/(?:^|\bawait\s+|=\s*)([\w$]+)\s*\(/)
      return n && match
        ? [{ name: match[1], line: n.source.startLine, column: n.source.startColumn ?? 1, target: child.id }]
        : []
    })
  const topology = section.topology ?? buildFlowTopology(section.nodes)
  const ranks = new Map<string, number>()
  function depth(list: ReadableNode[], level: number) {
    for (const n of list) {
      ranks.set(n.id, level)
      if (n.kind === 'branch') for (const p of n.paths) depth(p.children, level + 1)
      else if (n.kind === 'loop' || (n.kind === 'group' && n.origin !== 'helper')) depth(n.children, level + 1)
    }
  }
  depth(section.nodes, 0)
  const bySource = new Map(nodes.map((node) => [node.id, node]))
  const stepByBox = new Map<string, ReaderStep>()
  const boxes = topology.boxes.map((box) => {
    const node = box.sourceId && bySource.get(box.sourceId)
    if (!node) return box
    const call =
      calls.find((c) => c.target === node.id) ??
      (node.kind === 'leaf'
        ? calls.find(
            (c) =>
              c.direct &&
              c.line === node.source.startLine &&
              c.column >= (node.source.startColumn ?? 1) &&
              (c.line !== node.source.endLine || c.column < (node.source.endColumn ?? Infinity))
          )
        : undefined)
    const helper = call?.target ?? (children.some((s) => s.id === node.id) ? node.id : undefined)
    const label = node.flow?.caption?.replace(/\bid\b/g, 'ID') ?? box.label.replaceAll('`', '')
    stepByBox.set(box.id, {
      id: box.id,
      source: node.source,
      label,
      helper,
      depth: ranks.get(node.id) ?? 0,
      kind: helper ? 'helper' : box.shape === 'decision' ? 'decision' : box.shape === 'check' ? 'check' : 'action',
    })
    return { ...box, label }
  })
  const steps = [...stepByBox.values()].sort(
    (a, b) => a.source.startLine - b.source.startLine || (a.source.startColumn ?? 0) - (b.source.startColumn ?? 0)
  )
  const story = section.id === 'test' ? test.readable.story : section.implementation?.story
  const notes = readableStorySequenceEntries(story?.steps ?? []).filter((e) => e.item.role === 'note')
  const hints = new Map<string, string>()
  for (const { item } of notes) {
    const step = steps.find((step) => step.source.startLine === item.source.endLine + 1)
    if (step) hints.set(step.id, item.source.snippet)
  }
  return { source, calls, steps, notes, hints, stepByBox, section: { ...section, topology: { ...topology, boxes } } }
}
export type ReaderModel = ReturnType<typeof readerModel>
