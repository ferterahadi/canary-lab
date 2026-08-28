import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import type { ReadableFidelity } from '../../../../../shared/readable-tests/types'
import {
  quoteReadableText,
  renderExpression,
  renderNamedCallResult,
  type RenderedExpression,
} from './expression'
import { humanizeIdentifier } from './language'
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
  settlement?: 'resolves' | 'rejects'
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
  let settlement: Expectation['settlement']
  while (ts.isPropertyAccessExpression(receiver)) {
    const modifier = receiver.name.text
    if (modifier === 'not' && !negated) {
      negated = true
      receiver = receiver.expression
      continue
    }
    if ((modifier === 'resolves' || modifier === 'rejects') && !settlement) {
      settlement = modifier
      receiver = receiver.expression
      continue
    }
    break
  }
  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'not') {
    // A duplicate modifier is not a standard expectation chain.
    return undefined
  }
  if (
    ts.isPropertyAccessExpression(receiver)
    && (receiver.name.text === 'resolves' || receiver.name.text === 'rejects')
  ) {
    // Likewise, do not reinterpret contradictory settlement modifiers.
    return undefined
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
    ...(settlement ? { settlement } : {}),
    message: receiver.arguments[1],
  }
}

function renderCallAwareExpression(expression: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  const rendered = renderExpression(expression, sourceFile)
  if (rendered.fidelity !== 'unresolved') return rendered
  let unwrapped = expression
  while (
    ts.isAwaitExpression(unwrapped)
    || ts.isParenthesizedExpression(unwrapped)
    || ts.isAsExpression(unwrapped)
    || ts.isTypeAssertionExpression(unwrapped)
    || ts.isNonNullExpression(unwrapped)
    || ts.isSatisfiesExpression(unwrapped)
  ) unwrapped = unwrapped.expression
  return ts.isCallExpression(unwrapped)
    ? renderNamedCallResult(unwrapped, sourceFile, { allowBareZeroArguments: true }) ?? rendered
    : rendered
}

function renderSubject(actual: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  const locator = renderLocator(actual, sourceFile)
  if (locator) return locator
  if (ts.isIdentifier(actual) && actual.text === 'page') return { text: 'the page', fidelity: 'derived' }
  return renderCallAwareExpression(actual, sourceFile)
}

function renderExpectationSubject(expectation: Expectation, sourceFile: ts.SourceFile): RenderedExpression {
  const subject = renderSubject(expectation.actual, sourceFile)
  if (subject.fidelity === 'unresolved' || !expectation.settlement) return subject
  return {
    text: expectation.settlement === 'resolves'
      ? `the resolved value of ${subject.text}`
      : `the rejection from ${subject.text}`,
    fidelity: 'derived',
  }
}

function state(context: AssertionContext, positive: string, negative = `not ${positive}`): string {
  return `${context.subject.text} is ${context.negated ? negative : positive}`
}

function relation(context: AssertionContext, positive: string, negative: string): string {
  return `${context.subject.text} ${context.negated ? negative : positive} ${context.expected?.text}`
}

function assertionPrefix(expectation: Expectation): string {
  return expectation.soft ? 'Soft-check that' : 'Check that'
}

function assertionMessage(expectation: Expectation): string {
  if (!expectation.message) return ''
  // Diagnostic context is not part of what the assertion proves. Preserve
  // authored text, but do not promote a readable computation to a requirement.
  if (!ts.isStringLiteralLike(expectation.message)) return ''
  return ` with message ${quoteReadableText(expectation.message.text)}`
}

function renderPropertyExpectation(
  expectation: Expectation,
  sourceFile: ts.SourceFile,
): RenderedAssertion | undefined {
  if (expectation.matcher !== 'toHaveProperty') return undefined
  if (expectation.matcherCall.arguments.length < 1 || expectation.matcherCall.arguments.length > 2) {
    return fallback(expectation.matcherCall, sourceFile)
  }
  const subject = renderExpectationSubject(expectation, sourceFile)
  const property = renderCallAwareExpression(expectation.matcherCall.arguments[0], sourceFile)
  const expectedNode = expectation.matcherCall.arguments[1]
  const expected = expectedNode && renderCallAwareExpression(expectedNode, sourceFile)
  if (subject.fidelity === 'unresolved' || property.fidelity === 'unresolved' || expected?.fidelity === 'unresolved') {
    return fallback(expectation.matcherCall, sourceFile)
  }
  const relation = expected
    ? `${expectation.negated ? 'does not have' : 'has'} property ${property.text} equal to ${expected.text}`
    : `${expectation.negated ? 'does not have' : 'has'} property ${property.text}`
  return {
    text: `${assertionPrefix(expectation)} ${subject.text} ${relation}${assertionMessage(expectation)}`,
    fidelity: 'derived',
    role: 'check',
  }
}

function callDescription(call: ts.CallExpression, sourceFile: ts.SourceFile): string | undefined {
  let name: string | undefined
  let receiver: RenderedExpression | undefined
  if (ts.isIdentifier(call.expression)) {
    name = humanizeIdentifier(call.expression.text)
  } else if (ts.isPropertyAccessExpression(call.expression)) {
    name = humanizeIdentifier(call.expression.name.text)
    receiver = renderExpression(call.expression.expression, sourceFile)
    if (receiver.fidelity === 'unresolved') return undefined
  }
  if (!name) return undefined
  const arguments_ = call.arguments.map((argument) => renderExpression(argument, sourceFile))
  if (arguments_.some((argument) => argument.fidelity === 'unresolved')) return undefined
  return [
    `calling ${name}`,
    receiver ? `on ${receiver.text}` : undefined,
    arguments_.length ? `using ${arguments_.map((argument) => argument.text).join(' and ')}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(' ')
}

function thrownOperation(actual: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  let expression = actual
  while (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) expression = expression.expression
  if (ts.isIdentifier(expression)) return humanizeIdentifier(expression.text)
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return undefined
  let body: ts.Expression | undefined
  if (!ts.isBlock(expression.body)) {
    body = expression.body
  } else if (expression.body.statements.length === 1) {
    const [statement] = expression.body.statements
    body = ts.isExpressionStatement(statement)
      ? statement.expression
      : ts.isReturnStatement(statement)
        ? statement.expression
        : undefined
  }
  while (body && (ts.isAwaitExpression(body) || ts.isParenthesizedExpression(body))) body = body.expression
  return body && ts.isCallExpression(body)
    ? callDescription(body, sourceFile)
    : 'the provided operation'
}

function renderThrowExpectation(
  expectation: Expectation,
  sourceFile: ts.SourceFile,
): RenderedAssertion | undefined {
  if (expectation.matcher !== 'toThrow' && expectation.matcher !== 'toThrowError') return undefined
  if (expectation.matcherCall.arguments.length > 1) return fallback(expectation.matcherCall, sourceFile)
  const expectedNode = expectation.matcherCall.arguments[0]
  const expected = expectedNode && renderCallAwareExpression(expectedNode, sourceFile)
  if (expected?.fidelity === 'unresolved') return fallback(expectation.matcherCall, sourceFile)
  const expectedText = expectedNode && ts.isIdentifier(expectedNode)
    ? ` of type ${expectedNode.text}`
    : expected
      ? ` matching ${expected.text}`
      : ''
  if (expectation.settlement === 'rejects') {
    const subject = renderExpectationSubject(expectation, sourceFile)
    if (subject.fidelity === 'unresolved') return fallback(expectation.matcherCall, sourceFile)
    return {
      text: `${assertionPrefix(expectation)} ${subject.text} ${expectation.negated ? 'is not' : 'is'} an error${expectedText}${assertionMessage(expectation)}`,
      fidelity: 'derived',
      role: 'check',
    }
  }
  if (expectation.settlement === 'resolves') {
    const subject = renderExpectationSubject(expectation, sourceFile)
    if (subject.fidelity === 'unresolved') return fallback(expectation.matcherCall, sourceFile)
    return {
      text: `${assertionPrefix(expectation)} ${subject.text} ${expectation.negated ? 'does not throw' : 'throws'} an error${expectedText}${assertionMessage(expectation)}`,
      fidelity: 'derived',
      role: 'check',
    }
  }
  const operation = thrownOperation(expectation.actual, sourceFile)
  if (!operation) return fallback(expectation.matcherCall, sourceFile)
  return {
    text: `${assertionPrefix(expectation)} ${operation} ${expectation.negated ? 'does not throw' : 'throws'} an error${expectedText}${assertionMessage(expectation)}`,
    fidelity: 'derived',
    role: 'check',
  }
}

function renderGenericExpectation(
  expectation: Expectation,
  sourceFile: ts.SourceFile,
): RenderedAssertion {
  const subject = renderExpectationSubject(expectation, sourceFile)
  const arguments_ = expectation.matcherCall.arguments.map((argument) => renderCallAwareExpression(argument, sourceFile))
  if (subject.fidelity === 'unresolved' || arguments_.some((argument) => argument.fidelity === 'unresolved')) {
    return fallback(expectation.matcherCall, sourceFile)
  }
  const check = humanizeIdentifier(expectation.matcher).replace(/^to /, '')
  const using = arguments_.length ? ` using ${arguments_.map((argument) => argument.text).join(' and ')}` : ''
  return {
    text: `${assertionPrefix(expectation)} ${subject.text} ${expectation.negated ? 'does not pass' : 'passes'} the “${check}” check${using}${assertionMessage(expectation)}`,
    fidelity: 'derived',
    role: 'check',
  }
}

/** Story mode may name a safe custom matcher without claiming to understand
 * its domain semantics. The exhaustive renderer still keeps exact source. */
export function renderGenericAssertionStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): RenderedAssertion | undefined {
  const call = unwrapCall(statement)
  if (!call) return undefined
  const expectation = parseExpectation(call)
  if (!expectation) return undefined
  if (
    expectation.matcher === 'toHaveProperty'
    || expectation.matcher === 'toThrow'
    || expectation.matcher === 'toThrowError'
    || ASSERTION_RULES.some((rule) => rule.matchers.has(expectation.matcher))
  ) return undefined
  return renderGenericExpectation(expectation, sourceFile)
}

function isCollectionPredicate(expression: ts.Expression): boolean {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && (
      current.expression.name.text === 'every'
      || current.expression.name.text === 'some'
      || (
        current.expression.name.text === 'isArray'
        && ts.isIdentifier(current.expression.expression)
        && current.expression.expression.text === 'Array'
      )
    )
}

function collectionPredicateState(context: AssertionContext, asserted: boolean): string | undefined {
  if (!isCollectionPredicate(context.actual)) return undefined
  return asserted ? context.subject.text : `it is false that ${context.subject.text}`
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
    if (
      context.matcher === 'toBe'
      || context.matcher === 'toEqual'
      || context.matcher === 'toStrictEqual'
    ) {
      const expected = context.matcherCall.arguments[0]
      if (expected.kind === ts.SyntaxKind.TrueKeyword || expected.kind === ts.SyntaxKind.FalseKeyword) {
        const expectedValue = expected.kind === ts.SyntaxKind.TrueKeyword
        const collectionState = collectionPredicateState(context, expectedValue !== context.negated)
        if (collectionState) return collectionState
      }
    }
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
    if (context.matcher === 'toBeTruthy' || context.matcher === 'toBeFalsy') {
      const expectedValue = context.matcher === 'toBeTruthy'
      const collectionState = collectionPredicateState(context, expectedValue !== context.negated)
      if (collectionState) return collectionState
    }
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
  const special = renderPropertyExpectation(expectation, sourceFile)
    ?? renderThrowExpectation(expectation, sourceFile)
  if (special) return special
  const rule = ASSERTION_RULES.find((candidate) => candidate.matchers.has(expectation.matcher))
  if (!rule) return fallback(call, sourceFile)
  if (call.arguments.length < rule.expectedArguments) return fallback(call, sourceFile)

  const subject = renderExpectationSubject(expectation, sourceFile)
  const expected = rule.expectedArguments === 1 ? renderCallAwareExpression(call.arguments[0], sourceFile) : undefined
  const optionStart = rule.expectedArguments
  const options = call.arguments.slice(optionStart).map((argument) => renderCallAwareExpression(argument, sourceFile))
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
  const prefix = assertionPrefix(expectation)
  const optionsText = options.length ? ` using ${options.map((option) => option.text).join(' and ')}` : ''
  // A diagnostic message does not change what the assertion proves. Keep the
  // check when that optional context is dynamic instead of hiding the entire
  // requirement behind a source fallback.
  const messageText = assertionMessage(expectation)
  return {
    text: `${prefix} ${rule.render(context)}${optionsText}${messageText}`,
    fidelity: 'derived',
    role: 'check',
  }
}
