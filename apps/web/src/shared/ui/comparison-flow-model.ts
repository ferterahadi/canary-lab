import { compareText } from '@shared/lib/comparison-diff'
import type { ExtractedTest } from '@shared/extracted-test'
import { flowSections, sectionNodes, type FlowSection } from '@shared/test-view/flow-layout'
import type { FlowBox, FlowEdge } from '@shared/test-view/flow-graph'
import { REVIEW_FILE_SCOPE, reviewCaseKey, type ReviewSource } from '@shared/test-review'
import type { TestViewSide } from '@shared/test-view/render-model'
import type { ReadableNode } from '@shared/readable-tests/types'
import { definitionFor, readerModel, readerSections, type ReaderModel, type ReaderStep, type StepChange } from './test-reader-model'

type Side = TestViewSide
type Pair<T> = { before?: T; after?: T }
export const otherSide = (side: Side): Side => (side === 'before' ? 'after' : 'before')

export function reviewReader(source: ReviewSource, side: Side, card: string | undefined) {
  if (!card) return
  const entry = source.tests.find((t) => reviewCaseKey(t) === card)
  const readable = card === REVIEW_FILE_SCOPE ? source.fileFlow : entry?.readable
  const graph = readable?.graph
  const body = graph?.sections[0]?.definition
  if (
    !readable ||
    graph?.schemaVersion !== 1 ||
    graph.origin.kind !== side ||
    !body ||
    body.startOffset == null ||
    body.endOffset == null
  )
    return
  const test: ExtractedTest = {
    name: readable.title,
    line: entry?.line ?? 1,
    bodyLine: body.startLine,
    bodySource: source.source.slice(body.startOffset, body.endOffset),
    steps: [],
    readable,
  }
  const sections = readerSections(flowSections(readable.nodes, graph), readable)
  const logical = source.fileFlow?.graph?.case.file
  const physical = source.tests[0]?.readable.graph?.case.file ?? body.file
  const root = logical && physical.endsWith('/' + logical) ? physical.slice(0, -logical.length) : undefined
  return { test, sections, file: body.file, root }
}
type Reader = NonNullable<ReturnType<typeof reviewReader>>

function definitionKey(reader: Reader, section: FlowSection) {
  const def = definitionFor(section, reader.test.readable)
  if (def) {
    const file =
      reader.root && def.source.file.startsWith(reader.root)
        ? def.source.file.slice(reader.root.length)
        : def.source.file
    return JSON.stringify([def.suiteFile ?? file, def.name])
  }
}

/** Section IDs include revision-specific offsets. Resolve the counterpart using
 * the authored definition, accepting only an unambiguous target in that file. */
export function counterpart(reader: Reader, section: FlowSection, peer: Reader) {
  if (section.id === 'test') return peer.sections[0]
  const key = definitionKey(reader, section)
  if (!key) return
  const candidates = peer.sections.filter((s) => s.id.startsWith('def-') && definitionKey(peer, s) === key)
  if (candidates.length === 1) return candidates[0]
}

type Unit = { step: ReaderStep; node: ReadableNode; box: FlowBox; exact: string; shape: string; body?: string }
function units(model: ReaderModel, reader: Reader): Unit[] {
  const nodes = new Map(sectionNodes(model.section).map((n) => [n.id, n]))
  const boxes = new Map(model.section.topology.boxes.map((b) => [b.id, b]))
  const helpers = new Map(reader.sections.map((s) => [s.id, s]))
  return model.steps.map((step) => {
    const box = boxes.get(step.id)!
    const node = nodes.get(box.sourceId!)!
    const helper = step.helper && helpers.get(step.helper)
    // Containers include all child source in their range. Compare their own
    // caption so one inserted field does not mark the entire object modified.
    const raw = node.kind === 'leaf' || helper ? node.source.snippet : step.label
    const tokens =
      raw.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\d+(?:[._]\d+)*|[\w$]+|[^\s]/g) ?? []
    const identity = [step.kind, step.depth, box.id.slice(box.sourceId!.length)]
    const exact = JSON.stringify([...identity, tokens])
    const shape = JSON.stringify([
      ...identity,
      tokens.map((t) => (/^\d/.test(t) ? '#number' : /^["'`]/.test(t) ? '#string' : t)),
    ])
    const body = helper
      ? (definitionFor(helper, reader.test.readable)?.source ?? helper.implementation?.source)?.snippet
      : undefined
    return { step, node, box, exact, shape, body }
  })
}

// The shared, bounded diff keeps repeated statements in sequence. Match exact
// statements first, then pair literal edits only inside the remaining gaps.
function align(a: Unit[], b: Unit[], key: 'exact' | 'shape'): Pair<Unit>[] {
  const ids = new Map<string, number>()
  const encode = (list: Unit[]) =>
    list
      .map((u) => {
        if (!ids.has(u[key])) ids.set(u[key], ids.size)
        return ids.get(u[key]) + '\n'
      })
      .join('')
  const diff = compareText(encode(a), encode(b), 'lines')
  const flags = (side: Side) => diff[side].flatMap((p) => Array<boolean>(p.text.split('\n').length - 1).fill(p.changed))
  const left = flags('before'),
    right = flags('after'),
    result: Pair<Unit>[] = []
  let i = 0,
    j = 0
  while (i < a.length || j < b.length) {
    const first = i,
      second = j
    while (left[i]) i++
    while (right[j]) j++
    if (first !== i || second !== j) {
      const old = a.slice(first, i),
        next = b.slice(second, j)
      if (key === 'exact' && old.length && next.length) for (const pair of align(old, next, 'shape')) result.push(pair)
      else {
        for (const before of old) result.push({ before })
        for (const after of next) result.push({ after })
      }
    } else result.push({ before: a[i++], after: b[j++] })
  }
  return result
}

function changeDetail(before: Unit, after: Unit) {
  const sameLabel = before.step.label === after.step.label
  const a = sameLabel ? before.step.source.snippet : before.step.label
  const b = sameLabel ? after.step.source.snippet : after.step.label
  const diff = compareText(a, b)
  const value = (side: Side) =>
    diff[side]
      .filter((p) => p.changed)
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join(' … ')
  // A decimal edit can share punctuation or digits; retain complete measures.
  const measure = /\b\d+(?:\.\d+)?(?:\s+(?:seconds?|ms|milliseconds?|minutes?))?\b/g
  const old = a.match(measure),
    current = b.match(measure)
  if (old?.length === 1 && current?.length === 1 && a.replace(measure, '#') === b.replace(measure, '#'))
    return old[0] + ' → ' + current[0]
  return (value('before') || '∅') + ' → ' + (value('after') || '∅')
}

export const flowEdgeKey = (e: Pick<FlowEdge, 'from' | 'to' | 'label' | 'kind'>) =>
  JSON.stringify([e.from, e.to, e.label, e.kind])

export function combinedFlow(readers: Pair<Reader>, side: Side, section: FlowSection) {
  const primary = readers[side]!,
    other = otherSide(side),
    peer = readers[other]
  const peerSection = peer && counterpart(primary, section, peer)
  const models: Pair<ReaderModel> = { [side]: readerModel(primary.test, primary.file, section, primary.sections) }
  if (peer && peerSection) models[other] = readerModel(peer.test, peer.file, peerSection, peer.sections)
  const base = models.after ?? models.before!
  const pairs = align(
    models.before ? units(models.before, readers.before!) : [],
    models.after ? units(models.after, readers.after!) : [],
    'exact'
  )
  const steps: ReaderStep[] = [],
    nodes: ReadableNode[] = [],
    boxes: FlowBox[] = []
  const aliases = { before: new Map<string, string>(), after: new Map<string, string>() }
  const sources = new Map<string, { side: Side; section: string; step: ReaderStep }>()
  const sections = { [side]: section, [other]: peerSection }
  let order = 0
  for (const { before, after } of pairs) {
    const u = (after ?? before)!,
      owner = after ? 'after' : 'before'
    const id = owner + ':' + u.box.id
    if (before) aliases.before.set(before.box.id, id)
    if (after) aliases.after.set(after.box.id, id)
    const change: StepChange | undefined =
      peer && !peerSection
        ? undefined
        : !before
          ? { kind: 'added' }
          : !after
            ? { kind: 'removed' }
            : before.exact !== after.exact
              ? { kind: 'modified', detail: changeDetail(before, after) }
              : before.body !== undefined && after.body !== undefined && before.body !== after.body
                ? { kind: 'inside' }
                : undefined
    // Lines in the removed revision cannot be sorted against current lines.
    // Keep their position in the alignment, including runs of adjacent removals.
    if (after || !models.after) order = u.step.source.startLine
    const step = { ...u.step, id, change, order, side: owner } satisfies ReaderStep
    steps.push(step)
    nodes.push({
      kind: 'leaf',
      role: 'action',
      fidelity: u.node.fidelity,
      text: u.node.text,
      source: u.step.source,
      id,
    })
    boxes.push({ ...u.box, id, sourceId: id })
    sources.set(id, { side: owner, section: sections[owner]!.id, step: u.step })
  }
  const edges = new Map<string, FlowEdge>()
  const origins = new Map<string, Side>()
  for (const revision of ['before', 'after'] as const) {
    const topology = models[revision]?.section.topology
    if (!topology) continue
    for (const box of topology.boxes.filter((b) => !aliases[revision].has(b.id))) {
      aliases[revision].set(box.id, box.id)
      if (!boxes.some((b) => b.id === box.id)) boxes.push(box)
    }
    for (const edge of topology.edges) {
      const mapped = { ...edge, from: aliases[revision].get(edge.from)!, to: aliases[revision].get(edge.to)! }
      const key = flowEdgeKey(mapped)
      if (edges.has(key) && origins.get(key) !== revision) origins.delete(key)
      else if (!edges.has(key)) origins.set(key, revision)
      edges.set(key, mapped)
    }
  }
  const hints = new Map(
    steps.flatMap((s) => {
      const owner = sources.get(s.id)!
      const hint = models[owner.side]?.hints.get(owner.step.id)
      return hint ? [[s.id, hint] as const] : []
    })
  )
  const model: ReaderModel = {
    ...base,
    steps,
    stepByBox: new Map(steps.map((s) => [s.id, s])),
    hints,
    section: { ...base.section, nodes, topology: { ...base.section.topology, boxes, edges: [...edges.values()] } },
  }
  if (peer && !peerSection) origins.clear()
  return { model, origins, sources, models, peerUnavailable: !!peer && !peerSection }
}
