import type { ReadableBranchPath, ReadableNode } from '../../../../../../../shared/readable-tests/types'
import { parseSource } from '../../../../shared/controlled-english/compiler-context'
import { isMeaningfulFlowStatement } from '../../../../shared/readable-tests/language'
import { translateReadableTest, type ReadableHelperInput } from '../../../../shared/readable-tests/translator'
import { qualitySummary } from './assertions'
import { sourceKey } from './ast'
import { renderFlowchartSvg } from './flowchart-svg'
import { deterministicEvaluationRewrite, normalizeEvaluationRewrite } from './rewrite'
import { flattenHelpers } from './source-analysis'
import { cleanSnippet } from './text'
import type { EvaluationRewrite, EvaluationRewriteFlowStep, FlowNode, TestFlowchart, TestReviewCase, TestReviewPacket } from './types'

export { calledNameFromText, setupLikeStatement } from '../../../../shared/readable-tests/language'
export { isMeaningfulFlowStatement }

export function createFlowcharts(packet: TestReviewPacket, rewrite: EvaluationRewrite): TestFlowchart[] {
  return packet.tests.map((test, idx) => {
    // One case per test is an invariant of both producers: `normalizeEvaluationRewrite`
    // rejects any input whose `cases.length` differs from `packet.tests.length`,
    // and `deterministicEvaluationRewrite` maps straight over `packet.tests`.
    const rewriteCase = rewrite.cases[idx]
    const steps = applyFlowStepRewrite(flowNodesForTest(test), rewriteCase.flowSteps)
    return {
      testName: test.name,
      steps,
      svg: renderFlowchartSvg(steps, rewriteCase.title, idx),
    }
  })
}

export function applyFlowStepRewrite(nodes: FlowNode[], steps: EvaluationRewriteFlowStep[] | undefined): FlowNode[] {
  if (!steps?.length) return nodes
  return nodes.map((node, idx) => {
    const rewrite = steps[idx]
    if (!rewrite?.title) return node
    return {
      ...node,
      title: rewrite.title,
      ...(rewrite.detail !== undefined ? { detail: rewrite.detail } : {}),
    }
  })
}

// Cap the flow at a readable length; an overflow is summarized in one node so even
// a huge test stays scannable.
export const MAX_FLOW_STEPS = 24

export function flowNodesForTest(test: TestReviewCase): FlowNode[] {
  if (!test.testBody) {
    return [
      { kind: 'start', title: test.title },
      { kind: 'setup', title: 'Source unavailable', detail: qualitySummary(test.assertions) || 'No static source match' },
      { kind: 'end', title: `Result: ${test.status}` },
    ]
  }
  const rootFile = sourceFileFor(test)
  const readable = translateReadableTest({
    file: rootFile,
    title: test.title,
    bodySource: test.testBody,
    // Evaluation displays the callback body itself, including its opening brace,
    // so body-relative lines keep flow-node clicks aligned with that code block.
    startLine: 1,
    helpers: readableHelpers(test),
  })
  const assertionSources = assertionSourcesFor(test, rootFile)
  const translatedSteps = readable.nodes.flatMap((node) => flowNodesForReadable(node, rootFile, assertionSources))
  const allSteps = translatedSteps.length || /^\s*\{\s*\}\s*$/.test(test.testBody)
    ? translatedSteps
    : test.testBody
        .split('\n')
        .map((line, idx): FlowNode => ({
          kind: 'action',
          title: 'Review this source step',
          detail: cleanSnippet(line),
          codeLine: idx + 1,
          readable: true,
        }))
        .filter((node) => node.detail)
  const stepNodes: FlowNode[] = allSteps.length > MAX_FLOW_STEPS
    ? [
        ...allSteps.slice(0, MAX_FLOW_STEPS),
        { kind: 'setup', title: `+${allSteps.length - MAX_FLOW_STEPS} more steps`, detail: 'further statements omitted for brevity' },
      ]
    : allSteps
  return [
    { kind: 'start', title: test.title },
    ...stepNodes,
    { kind: 'end', title: `Result: ${test.status}` },
  ]
}

function sourceFileFor(test: TestReviewCase): string {
  const location = sourceKey(test.location ?? '')
  const match = location.match(/^(.*):\d+$/)
  return match?.[1] || 'evaluation.spec.ts'
}

function readableHelpers(test: TestReviewCase): ReadableHelperInput[] {
  return flattenHelpers(test.helperDefinitions).flatMap((helper) => helper.bodySource
    ? [{
        name: helper.name,
        file: helper.file,
        bodySource: helper.bodySource,
        startLine: helper.startLine,
      }]
    : [])
}

interface AssertionSource {
  file: string
  snippet: string
}

function assertionSourcesFor(test: TestReviewCase, rootFile: string): readonly AssertionSource[] {
  const sources: AssertionSource[] = []
  const add = (file: string, snippet: string): void => {
    const cleaned = cleanSnippet(snippet)
    // An unknown-assertion placeholder deliberately carries an empty snippet.
    // Treating it as a substring would classify every statement as a check.
    if (cleaned) sources.push({ file, snippet: cleaned })
  }
  for (const assertion of test.assertions) add(rootFile, assertion.snippet)
  for (const helper of flattenHelpers(test.helperDefinitions)) {
    for (const assertion of helper.assertions) add(helper.file, assertion.snippet)
  }
  return sources
}

function flowKind(node: ReadableNode, assertionSources: readonly AssertionSource[]): FlowNode['kind'] {
  if (node.kind !== 'leaf') return node.kind === 'group' ? 'helper' : 'action'
  const sourceSnippet = cleanSnippet(node.source.snippet)
  if (assertionSources.some((source) => (
    source.file === node.source.file && sourceSnippet.includes(source.snippet)
  ))) return 'assertion'
  return 'action'
}

function readableFlowNode(
  node: ReadableNode | ReadableBranchPath,
  rootFile: string,
  kind: FlowNode['kind'],
): FlowNode {
  return {
    kind,
    title: node.text,
    detail: node.source.snippet,
    ...(node.source.file === rootFile ? { codeLine: node.source.startLine } : {}),
    readable: true,
  }
}

function helperChildCarriesFlow(node: ReadableNode): boolean {
  const { sourceFile } = parseSource(node.source.file, node.source.snippet)
  return sourceFile.statements.some(isMeaningfulFlowStatement)
}

function flowNodesForReadable(
  node: ReadableNode,
  rootFile: string,
  assertionSources: readonly AssertionSource[],
): FlowNode[] {
  const current = readableFlowNode(node, rootFile, flowKind(node, assertionSources))
  if (node.kind === 'leaf') return [current]
  if (node.kind === 'group' || node.kind === 'loop') {
    const children = node.kind === 'group' && node.origin === 'helper'
      ? node.children.filter(helperChildCarriesFlow)
      : node.children
    return [
      current,
      ...children.flatMap((child) => flowNodesForReadable(child, rootFile, assertionSources)),
    ]
  }
  return [
    current,
    ...node.paths.flatMap((path) => [
      readableFlowNode(path, rootFile, 'setup'),
      ...path.children.flatMap((child) => flowNodesForReadable(child, rootFile, assertionSources)),
    ]),
  ]
}
