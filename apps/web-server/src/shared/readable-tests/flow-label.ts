import ts from 'typescript'
import type { ReadableFlowLabel, ReadableNode } from '../../../../../shared/readable-tests/types'
import { authoredStepLabel, callFromExpression, callFromStatement } from './call-syntax'

function words(name: string) {
  return name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase()
}

function title(text: string) { return text.charAt(0).toUpperCase() + text.slice(1) }

function subject(expression: ts.Expression): string {
  if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) return subject(expression.expression)
  if (ts.isCallExpression(expression)) return subject(expression.expression)
  if (ts.isPropertyAccessExpression(expression)) return words(expression.name.text)
  if (ts.isIdentifier(expression)) return words(expression.text)
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text
  return expression.getText()
}

function question(expression: ts.Expression): string {
  const label = authoredStepLabel(callFromExpression(expression))
  if (label !== undefined) return label
  if (ts.isBinaryExpression(expression)) {
    const operators: Record<string, string> = { '===': 'is', '==': 'equals', '!==': 'differs from', '<': '<', '>': '>', '<=': '≤', '>=': '≥' }
    if (expression.left.getText() === 'Date.now()' && expression.operatorToken.kind === ts.SyntaxKind.LessThanToken) {
      return `Before ${subject(expression.right)}?`
    }
    return title(`${subject(expression.left)} ${operators[expression.operatorToken.getText()] ?? expression.operatorToken.getText()} ${subject(expression.right)}?`)
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'ok') return 'Response OK?'
  return title(subject(expression)) + '?'
}

/** Labels describe a single source statement. Its exact syntax and full arguments
 * stay available in the tooltip, including literals too long for a shape. */
export function flowLabel(s: ts.Statement, node: ReadableNode): ReadableFlowLabel {
  if (ts.isIfStatement(s)) return { kind: 'decision', label: question(s.expression) }
  if (ts.isSwitchStatement(s)) return { kind: 'decision', label: 'Switch on ' + subject(s.expression) }
  if (ts.isWhileStatement(s) || ts.isDoStatement(s)) return { kind: 'decision', label: question(s.expression) }
  if (ts.isForStatement(s)) return { kind: 'decision', label: s.condition ? question(s.condition) : 'Repeat' }
  if (ts.isForOfStatement(s) || ts.isForInStatement(s)) return { kind: 'decision', label: 'More ' + subject(s.expression) + '?' }
  if (ts.isTryStatement(s)) return { kind: 'try', label: 'Try' }
  if (ts.isThrowStatement(s)) {
    const message = ts.isNewExpression(s.expression) ? s.expression.arguments?.[0]?.getText() : undefined
    return { kind: 'throw', label: message && /timeout|timed out/i.test(message) ? 'Report timeout' : 'Raise error' }
  }
  if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
    return { kind: s.label ? 'opaque' : ts.isBreakStatement(s) ? 'break' : 'continue', label: s.getText().replace(/;$/, '') }
  }
  const call = callFromStatement(s)
  const kind = ts.isReturnStatement(s) ? 'return' : 'action'
  const stepLabel = authoredStepLabel(call)
  if (stepLabel !== undefined) return { kind, label: stepLabel }
  const callee = call?.expression
  const method = callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
  const io = node.english?.semanticCategories?.includes('external-api')
  if (call && method && io && ['get','post','put','patch','delete','head','fetch'].includes(method)) {
    const url = call.arguments[0]
    const target = url && ts.isTemplateExpression(url) ? url.templateSpans.at(-1)?.literal.text : url && subject(url)
    const host = url && ts.isTemplateExpression(url) ? subject(url.templateSpans[0].expression).replace(/ url$/, '') : undefined
    const label = method === 'get' && target === '/' && host ? 'Check ' + host
      : target && target !== '/' ? method.toUpperCase() + ' ' + target : method.toUpperCase() + ' request'
    return { kind: kind === 'return' ? 'return-io' : 'io', label }
  }
  if (call && callee && ts.isPropertyAccessExpression(callee) && node.english?.semanticCategories?.includes('assertion')) {
    const expect = callee.expression
    const actual = ts.isCallExpression(expect) && expect.arguments[0] ? subject(expect.arguments[0]) : 'value'
    const expected = call.arguments[0]
    const relation = ({toBe:'=',toEqual:'=',toMatchObject:'includes',toBeLessThanOrEqual:'≤',toBeGreaterThanOrEqual:'≥',toBeLessThan:'<'} as Record<string,string>)[callee.name.text]
    return { kind: 'check', label: relation && expected ? `Check ${actual} ${relation} ${subject(expected)}` : 'Check ' + words(callee.name.text) }
  }
  if (ts.isReturnStatement(s)) return { kind, label: s.expression ? 'Return ' + subject(s.expression) : 'Return' }
  if (node.kind === 'group' && node.fidelity === 'exact') return { kind, label: node.text }
  if (call && callee) return { kind, label: method === 'json' ? 'Read JSON body' : title(subject(callee)) }
  if (ts.isVariableStatement(s)) return { kind, label: 'Set ' + words(s.declarationList.declarations[0].name.getText()) }
  if (ts.isExpressionStatement(s) && ts.isAwaitExpression(s.expression)) {
    const awaited = s.expression.expression
    const executor = ts.isNewExpression(awaited) && awaited.expression.getText() === 'Promise' ? awaited.arguments?.[0] : undefined
    const timer = executor && ts.isArrowFunction(executor) && ts.isCallExpression(executor.body) ? executor.body : undefined
    const delay = timer?.expression.getText() === 'setTimeout' ? timer.arguments[1] : undefined
    return { kind, label: delay && ts.isNumericLiteral(delay) ? 'Wait ' + Number(delay.text) / 1000 + ' s' : 'Wait' }
  }
  return { kind, label: node.english?.text ?? node.text }
}

/** Keep the compact reading label independent of the execution label used by
 * saved reports and step counters. Units and comparisons come from the AST. */
export function readerCaption(s: ts.Statement, flow: ReadableFlowLabel): string | undefined {
  const call = callFromStatement(s)
  const callee = call?.expression
  if (flow.kind === 'check' && call && callee && ts.isPropertyAccessExpression(callee) && ts.isCallExpression(callee.expression)) {
    const left = callee.expression.arguments[0], right = call.arguments[0]
    if (!left || !right) return
    const actual = ts.isPropertyAccessExpression(left) && left.name.text === 'length'
      ? subject(left.expression) + ' length' : subject(left)
    const matcher = callee.name.text
    if (actual === 'elapsed ms' && ts.isNumericLiteral(right) && matcher === 'toBeLessThan') {
      const ms = Number(right.text)
      const duration = ms < 1000 ? ms + ' ms' : ms / 1000 + (ms === 1000 ? ' second' : ' seconds')
      return 'Check response time is under ' + duration
    }
    const http = actual === 'status' && /\b(GET|POST|PUT|PATCH|DELETE|HTTP)\b/.test(callee.expression.arguments[1]?.getText() ?? '')
    const label = http ? 'HTTP status' : actual
    if (matcher === 'toBe' || matcher === 'toEqual') {
      if (ts.isCallExpression(right) && right.expression.getText() === 'expect.any' && right.arguments.length === 1)
        return 'Check ' + label + ' is a ' + subject(right.arguments[0])
      return 'Check ' + label + ' is ' + subject(right)
    }
    const comparison: Record<string,string> = { toBeGreaterThan:'is greater than',toBeGreaterThanOrEqual:'is at least',
      toBeLessThan:'is under',toBeLessThanOrEqual:'is at most' }
    if (comparison[matcher]) return 'Check ' + label + ' ' + comparison[matcher] + ' ' + subject(right)
  }
  if (ts.isIfStatement(s)) {
    if (ts.isPropertyAccessExpression(s.expression)) return 'Check whether ' + subject(s.expression) + ' is set'
    return 'Check whether ' + question(s.expression).replace(/\?$/, '').replace(/^./, c=>c.toLowerCase())
  }
  if (call && callee && ts.isIdentifier(callee) && callee.text === 'call' && call.arguments[0]) return 'Call ' + subject(call.arguments[0])
  if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const {left,right} = s.expression
    const time = right.getText().match(/^new Date\(Date\.now\(\)\s*-\s*(\d+)\)\.toISOString\(\)$/)
    if (time) {
      const ms = Number(time[1])
      const duration = ms < 1000 ? ms + ' ms' : ms / 1000 + (ms === 1000 ? ' second' : ' seconds')
      return 'Set ' + subject(left).replace(/ iso$/, ' time') + ' to ' + duration + ' ago'
    }
    if (ts.isPropertyAccessExpression(right) || ts.isIdentifier(right)) {
      const destination = ts.isPropertyAccessExpression(left) ? left.expression.getText() : undefined
      return subject(left) === subject(right) && destination ? 'Save ' + subject(right) + ' to ' + destination :
        'Save ' + subject(right) + ' to ' + subject(left)
    }
  }
  if (ts.isVariableStatement(s) && s.declarationList.declarations.length === 1) {
    const {name,initializer} = s.declarationList.declarations[0]
    if (initializer && ts.isPropertyAccessExpression(initializer)) return 'Read ' + words(name.getText())
  }
}
