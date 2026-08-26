import type { ReadableBranchPath, ReadableNode } from '../../../../../../../shared/readable-tests/types'
import { translateReadableTest, type ReadableHelperInput } from '../../../../shared/readable-tests/translator'
import { qualitySummary } from './assertions'
import { sourceKey } from './ast'
import { renderFlowchartSvg } from './flowchart-svg'
import { deterministicEvaluationRewrite, normalizeEvaluationRewrite } from './rewrite'
import { flattenHelpers } from './source-analysis'
import { cleanSnippet } from './text'
import type { EvaluationRewrite, EvaluationRewriteFlowStep, FlowNode, TestFlowchart, TestReviewCase, TestReviewPacket } from './types'

export { calledNameFromText, isMeaningfulFlowStatement, setupLikeStatement } from '../../../../shared/readable-tests/language'

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
  const translatedSteps = readable.nodes.flatMap((node) => flowNodesForReadable(node, rootFile))
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

function flowKind(node: ReadableNode): FlowNode['kind'] {
  if (node.kind !== 'leaf') return node.kind === 'group' ? 'helper' : 'action'
  if (node.role === 'check') return 'assertion'
  if (node.role === 'setup') return 'setup'
  if (node.role === 'helper') return 'helper'
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

function flowNodesForReadable(node: ReadableNode, rootFile: string): FlowNode[] {
  const current = readableFlowNode(node, rootFile, flowKind(node))
  if (node.kind === 'leaf') return [current]
  if (node.kind === 'group' || node.kind === 'loop') {
    return [current, ...node.children.flatMap((child) => flowNodesForReadable(child, rootFile))]
  }
  return [
    current,
    ...node.paths.flatMap((path) => [
      readableFlowNode(path, rootFile, 'setup'),
      ...path.children.flatMap((child) => flowNodesForReadable(child, rootFile)),
    ]),
  ]
}
