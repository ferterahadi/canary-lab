import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import type { ReadableFidelity } from '../../../../../shared/readable-tests/types'
import { renderExpression, type RenderedExpression } from './expression'
import { renderLocator } from './locator'

export interface RenderedAssertion {
  text: string
  fidelity: ReadableFidelity
  role: 'check'
}

interface Expectation {
  matcher: string
  matcherCall: ts.CallExpression
  actual: ts.Expression
  negated: boolean
  soft: boolean
  message?: ts.Expression
}

interface AssertionContext extends Expectation {
  subject: RenderedExpression
  expected?: RenderedExpression
  options: RenderedExpression[]
  sourceFile: ts.SourceFile
}

interface AssertionRule {
  matchers: ReadonlySet<string>
  expectedArguments: 0 | 1
  render: (context: AssertionContext) => string
}

function fallback(node: ts.Node, sourceFile: ts.SourceFile): RenderedAssertion {
  return {
    text: formatSourceSnippetForDisplay(node.getText(sourceFile)),
    fidelity: 'unresolved',
    role: 'check',
  }
}

function unwrapCall(statement: ts.Statement): ts.CallExpression | undefined {
  const statementExpression = ts.isExpressionStatement(statement)
    ? statement.expression
    : ts.isReturnStatement(statement)
      ? statement.expression
      : undefined
  if (!statementExpression) return undefined
  let expression = statementExpression
  while (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression
  return ts.isCallExpression(expression) ? expression : undefined
}

function parseExpectation(call: ts.CallExpression): Expectation | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined
  const matcher = call.expression.name.text
  let receiver: ts.Expression = call.expression.expression
  let negated = false
  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'not') {
    negated = true
    receiver = receiver.expression
  }
  if (!ts.isCallExpression(receiver)) return undefined

  let soft = false
  if (ts.isIdentifier(receiver.expression) && receiver.expression.text === 'expect') {
    soft = false
  } else if (
    ts.isPropertyAccessExpression(receiver.expression)
    && ts.isIdentifier(receiver.expression.expression)
    && receiver.expression.expression.text === 'expect'
    && receiver.expression.name.text === 'soft'
  ) {
    soft = true
  } else {
    return undefined
  }
  const actual = receiver.arguments[0]
  if (!actual) return undefined
  return {
    matcher,
    matcherCall: call,
    actual,
    negated,
    soft,
    message: receiver.arguments[1],
  }
}

function renderSubject(actual: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  const locator = renderLocator(actual, sourceFile)
  if (locator) return locator
  if (ts.isIdentifier(actual) && actual.text === 'page') return { text: 'the page', fidelity: 'derived' }
  if (ts.isCallExpression(actual) && ts.isPropertyAccessExpression(actual.expression)) {
    const method = actual.expression.name.text
    const receiver = renderExpression(actual.expression.expression, sourceFile)
    if (receiver.fidelity !== 'unresolved' && actual.arguments.length === 0) {
      if (method === 'status') return { text: `${receiver.text} status`, fidelity: 'derived' }
      if (method === 'url') return { text: `${receiver.text} URL`, fidelity: 'derived' }
      if (method === 'ok') return { text: `whether ${receiver.text} is successful`, fidelity: 'derived' }
    }
  }
  return renderExpression(actual, sourceFile)
}

function state(context: AssertionContext, positive: string, negative = `not ${positive}`): string {
  return `${context.subject.text} is ${context.negated ? negative : positive}`
}

function relation(context: AssertionContext, positive: string, negative: string): string {
  return `${context.subject.text} ${context.negated ? negative : positive} ${context.expected?.text}`
}

const STATE_RULE: AssertionRule = {
  matchers: new Set(['toBeVisible', 'toBeHidden', 'toBeEnabled', 'toBeDisabled', 'toBeChecked', 'toBeEditable', 'toBeEmpty', 'toBeFocused', 'toBeAttached']),
  expectedArguments: 0,
  render(context) {
    const states: Record<string, string> = {
      toBeVisible: 'visible',
      toBeHidden: 'hidden',
      toBeEnabled: 'enabled',
      toBeDisabled: 'disabled',
      toBeChecked: 'checked',
      toBeEditable: 'editable',
      toBeEmpty: 'empty',
      toBeFocused: 'focused',
      toBeAttached: 'attached to the page',
    }
    return state(context, states[context.matcher])
  },
}

const VALUE_RULE: AssertionRule = {
  matchers: new Set(['toHaveText', 'toContainText', 'toHaveValue', 'toHaveURL', 'toHaveTitle', 'toHaveCount', 'toHaveLength', 'toEqual', 'toStrictEqual', 'toBe', 'toContain', 'toContainEqual', 'toMatch', 'toMatchObject']),
  expectedArguments: 1,
  render(context) {
    if (context.matcher === 'toHaveURL') {
      const subject = context.subject.text === 'the page' ? 'the page URL' : `${context.subject.text} URL`
      return `${subject} ${context.negated ? 'does not equal' : 'equals'} ${context.expected?.text}`
    }
    if (context.matcher === 'toHaveTitle') {
      const subject = context.subject.text === 'the page' ? 'the page title' : `${context.subject.text} title`
      return `${subject} ${context.negated ? 'does not equal' : 'equals'} ${context.expected?.text}`
    }
    const relations: Record<string, [string, string]> = {
      toHaveText: ['has text', 'does not have text'],
      toContainText: ['contains text', 'does not contain text'],
      toHaveValue: ['has value', 'does not have value'],
      toHaveCount: ['has count', 'does not have count'],
      toHaveLength: ['has length', 'does not have length'],
      toEqual: ['equals', 'does not equal'],
      toStrictEqual: ['exactly equals', 'does not exactly equal'],
      toBe: ['equals', 'does not equal'],
      toContain: ['contains', 'does not contain'],
      toContainEqual: ['contains an item equal to', 'does not contain an item equal to'],
      toMatch: ['matches', 'does not match'],
      toMatchObject: ['includes', 'does not include'],
    }
    const [positive, negative] = relations[context.matcher]
    return relation(context, positive, negative)
  },
}

const TRUTH_RULE: AssertionRule = {
  matchers: new Set(['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeUndefined', 'toBeNull', 'toBeNaN', 'toBeOK']),
  expectedArguments: 0,
  render(context) {
    const states: Record<string, [string, string]> = {
      toBeTruthy: ['true', 'false'],
      toBeFalsy: ['false', 'true'],
      toBeDefined: ['defined', 'undefined'],
      toBeUndefined: ['undefined', 'defined'],
      toBeNull: ['null', 'not null'],
      toBeNaN: ['not a number', 'a number'],
      toBeOK: ['successful', 'not successful'],
    }
    const [positive, negative] = states[context.matcher]
    return state(context, positive, negative)
  },
}

const COMPARISON_RULE: AssertionRule = {
  matchers: new Set(['toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual']),
  expectedArguments: 1,
  render(context) {
    const relations: Record<string, [string, string]> = {
      toBeGreaterThan: ['is greater than', 'is not greater than'],
      toBeGreaterThanOrEqual: ['is at least', 'is less than'],
      toBeLessThan: ['is less than', 'is not less than'],
      toBeLessThanOrEqual: ['is at most', 'is greater than'],
    }
    const [positive, negative] = relations[context.matcher]
    return relation(context, positive, negative)
  },
}

const INSTANCE_RULE: AssertionRule = {
  matchers: new Set(['toBeInstanceOf']),
  expectedArguments: 1,
  render(context) {
    // A class name is a proper noun — keep `Date` as written, never "date".
    const argument = context.matcherCall.arguments[0]
    const name = ts.isIdentifier(argument) ? argument.text : context.expected?.text
    return `${context.subject.text} ${context.negated ? 'is not an instance of' : 'is an instance of'} ${name}`
  },
}

const ASSERTION_RULES = [STATE_RULE, VALUE_RULE, TRUTH_RULE, COMPARISON_RULE, INSTANCE_RULE]

export function renderAssertionStatement(statement: ts.Statement, sourceFile: ts.SourceFile): RenderedAssertion | undefined {
  const call = unwrapCall(statement)
  if (!call) return undefined
  const expectation = parseExpectation(call)
  if (!expectation) return undefined
  const rule = ASSERTION_RULES.find((candidate) => candidate.matchers.has(expectation.matcher))
  if (!rule) return fallback(call, sourceFile)
  if (call.arguments.length < rule.expectedArguments) return fallback(call, sourceFile)

  const subject = renderSubject(expectation.actual, sourceFile)
  const expected = rule.expectedArguments === 1 ? renderExpression(call.arguments[0], sourceFile) : undefined
  const optionStart = rule.expectedArguments
  const options = call.arguments.slice(optionStart).map((argument) => renderExpression(argument, sourceFile))
  const message = expectation.message ? renderExpression(expectation.message, sourceFile) : undefined
  if (
    subject.fidelity === 'unresolved'
    || expected?.fidelity === 'unresolved'
    || options.some((option) => option.fidelity === 'unresolved')
  ) {
    return fallback(call, sourceFile)
  }

  const context: AssertionContext = {
    ...expectation,
    subject,
    expected,
    options,
    sourceFile,
  }
  const prefix = expectation.soft ? 'Soft-check that' : 'Check that'
  const optionsText = options.length ? ` using ${options.map((option) => option.text).join(' and ')}` : ''
  // A diagnostic message does not change what the assertion proves. Keep the
  // check when that optional context is dynamic instead of hiding the entire
  // requirement behind a source fallback.
  const messageText = message && message.fidelity !== 'unresolved' ? ` with message ${message.text}` : ''
  return {
    text: `${prefix} ${rule.render(context)}${optionsText}${messageText}`,
    fidelity: 'derived',
    role: 'check',
  }
}
