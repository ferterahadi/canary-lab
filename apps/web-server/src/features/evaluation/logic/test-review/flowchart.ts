import ts from 'typescript'
import { qualitySummary } from './assertions'
import { renderFlowchartSvg } from './flowchart-svg'
import { deterministicEvaluationRewrite, normalizeEvaluationRewrite } from './rewrite'
import { flattenHelpers } from './source-analysis'
import { cleanSnippet, inline } from './text'
import type { EvaluationRewrite, EvaluationRewriteFlowStep, FlowNode, HelperDefinition, TestFlowchart, TestReviewCase, TestReviewPacket } from './types'

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
  const allSteps = testBodyStatements(test).map((statement) => flowNodeForStatement(statement.text, test, statement.line))
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

// A leaf statement reads as a flow step when it DOES something — an `await` or a
// call (awaited actions, helper calls, `expect(...)` assertions). Pure literal /
// identifier declarations (`const url = '…'`) are flow noise and are dropped.
export function isMeaningfulFlowStatement(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(n) || ts.isAwaitExpression(n) || ts.isNewExpression(n)) { found = true; return }
    n.forEachChild(visit)
  }
  visit(node)
  return found
}

export function testBodyStatements(test: TestReviewCase): Array<{ text: string; line: number }> {
  const wrapped = `async function __canaryReviewBody() ${test.testBody}`
  const src = ts.createSourceFile('assertion-flow.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fn = src.statements.find(ts.isFunctionDeclaration)
  if (!fn?.body) {
    return test.testBody
      .split('\n')
      .map((line, idx) => ({ text: cleanSnippet(line), line: idx + 1 }))
      .filter((item) => item.text)
  }
  // Flatten control-flow containers so a test wrapped in `try {…}` (or if/loops)
  // surfaces its real steps in source order instead of collapsing into one node.
  // We descend into statement containers only — never into expressions / arrow
  // callbacks — so a leaf stays one node.
  const leaves: ts.Statement[] = []
  const walk = (stmt: ts.Statement): void => {
    if (ts.isBlock(stmt)) { stmt.statements.forEach(walk); return }
    if (ts.isTryStatement(stmt)) {
      walk(stmt.tryBlock)
      if (stmt.catchClause) walk(stmt.catchClause.block)
      if (stmt.finallyBlock) walk(stmt.finallyBlock)
      return
    }
    if (ts.isIfStatement(stmt)) {
      walk(stmt.thenStatement)
      if (stmt.elseStatement) walk(stmt.elseStatement)
      return
    }
    if (ts.isIterationStatement(stmt, false)) { walk(stmt.statement); return }
    leaves.push(stmt)
  }
  fn.body.statements.forEach(walk)
  return leaves
    .filter(isMeaningfulFlowStatement)
    .map((statement) => ({
      text: cleanSnippet(statement.getText(src)),
      line: src.getLineAndCharacterOfPosition(statement.getStart(src)).line + 1,
    }))
}

export function flowNodeForStatement(statement: string, test: TestReviewCase, codeLine: number): FlowNode {
  const assertion = test.assertions.find((item) => item.snippet === statement || statement.includes(item.snippet) || item.snippet.includes(statement))
  if (assertion) {
    return { kind: 'assertion', title: `${assertion.quality} assertion`, detail: inline(assertion.snippet), codeLine }
  }
  const helper = helperForStatement(statement, test)
  if (helper) {
    const nestedCount = helper.assertions.length + helper.dependencies.reduce((count, dep) => count + flattenHelpers([dep]).reduce((sum, item) => sum + item.assertions.length, 0), 0)
    return {
      kind: 'helper',
      title: `Helper: ${helper.name}`,
      detail: nestedCount ? `${nestedCount} nested assertion${nestedCount === 1 ? '' : 's'}` : inline(statement),
      codeLine,
    }
  }
  return {
    kind: setupLikeStatement(statement) ? 'setup' : 'action',
    title: setupLikeStatement(statement) ? 'Setup' : 'Action',
    detail: inline(statement),
    codeLine,
  }
}

export function helperForStatement(statement: string, test: TestReviewCase): HelperDefinition | undefined {
  const helperName = calledNameFromText(statement)
  if (!helperName) return undefined
  return flattenHelpers(test.helperDefinitions).find((helper) => helper.name === helperName || statement.includes(helper.name))
}

export function calledNameFromText(statement: string): string | undefined {
  const match = statement.match(/(?:await\s+|return\s+)?(?:\(?\s*)?([A-Za-z_$][\w$]*)\s*\(/)
  return match?.[1]
}

export function setupLikeStatement(statement: string): boolean {
  return /\b(route|mock|intercept|fixture|seed|login|storageState|setExtraHTTPHeaders|addInitScript)\b/i.test(statement)
}
