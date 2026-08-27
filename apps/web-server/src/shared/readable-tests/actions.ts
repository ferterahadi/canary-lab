import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import type { ReadableFidelity } from '../../../../../shared/readable-tests/types'
import { expressionPath, renderExpression, type RenderedExpression } from './expression'
import { renderLocator } from './locator'
import { humanizeIdentifier, sentenceCase } from './language'

export interface RenderedAction {
  text: string
  fidelity: ReadableFidelity
  role: 'setup' | 'action' | 'unknown'
}

interface CallContext {
  call: ts.CallExpression
  method: string
  receiver: ts.Expression
  sourceFile: ts.SourceFile
}

interface ActionRule {
  methods: ReadonlySet<string>
  matches: (context: CallContext) => boolean
  render: (context: CallContext) => RenderedAction
}

function sourceFallback(node: ts.Node, sourceFile: ts.SourceFile): RenderedAction {
  return {
    text: formatSourceSnippetForDisplay(node.getText(sourceFile)),
    fidelity: 'unresolved',
    role: 'unknown',
  }
}

function isPageReceiver(context: CallContext): boolean {
  return expressionPath(context.receiver)?.split('.').at(-1) === 'page'
}

function isKeyboardReceiver(context: CallContext): boolean {
  return expressionPath(context.receiver)?.endsWith('.keyboard') ?? false
}

function isRequestReceiver(context: CallContext): boolean {
  const receiver = expressionPath(context.receiver)?.split('.').at(-1)?.toLowerCase()
  return receiver === 'request' || receiver === 'api' || receiver === 'apirequest' || receiver === 'requestcontext' || receiver === 'axios'
}

function safeExpression(node: ts.Expression | undefined, sourceFile: ts.SourceFile): RenderedExpression | undefined {
  if (!node) return undefined
  return renderExpression(node, sourceFile)
}

function safeOptions(call: ts.CallExpression, start: number, sourceFile: ts.SourceFile): string | null {
  const options = call.arguments.slice(start).map((argument) => renderExpression(argument, sourceFile))
  if (options.some((option) => option.fidelity === 'unresolved')) return null
  return options.length ? ` using ${options.map((option) => option.text).join(' and ')}` : ''
}

function action(text: string, fidelity: ReadableFidelity = 'derived'): RenderedAction {
  return { text, fidelity, role: 'action' }
}

function setup(text: string, fidelity: ReadableFidelity = 'derived'): RenderedAction {
  return { text, fidelity, role: 'setup' }
}

function locatorTarget(context: CallContext): { target: RenderedExpression; argumentOffset: number } | undefined {
  const locator = renderLocator(context.receiver, context.sourceFile)
  if (locator) return { target: locator, argumentOffset: 0 }
  const selector = safeExpression(context.call.arguments[0], context.sourceFile)
  if (!selector) return undefined
  return {
    target: selector.fidelity === 'unresolved'
      ? selector
      : { text: `the element matching ${selector.text}`, fidelity: 'derived' },
    argumentOffset: 1,
  }
}

const NAVIGATION_RULE: ActionRule = {
  methods: new Set(['goto', 'goBack', 'goForward', 'reload', 'waitForURL', 'waitForLoadState']),
  matches: isPageReceiver,
  render(context) {
    const { call, method, sourceFile } = context
    if (method === 'goBack' || method === 'goForward' || method === 'reload') {
      const options = safeOptions(call, 0, sourceFile)
      if (options === null) return sourceFallback(call, sourceFile)
      const wording = method === 'goBack'
        ? 'Go back to the previous page'
        : method === 'goForward'
          ? 'Go forward to the next page'
          : 'Reload the page'
      return action(`${wording}${options}`)
    }
    if (method === 'waitForLoadState') {
      const state = safeExpression(call.arguments[0], sourceFile)
      if (state?.fidelity === 'unresolved') return sourceFallback(call, sourceFile)
      const options = safeOptions(call, state ? 1 : 0, sourceFile)
      if (options === null) return sourceFallback(call, sourceFile)
      return action(`${state ? `Wait for the page to reach ${state.text}` : 'Wait for the page to finish loading'}${options}`)
    }
    const target = safeExpression(call.arguments[0], sourceFile)
    if (!target || target.fidelity === 'unresolved') return sourceFallback(call, sourceFile)
    const options = safeOptions(call, 1, sourceFile)
    if (options === null) return sourceFallback(call, sourceFile)
    return action(`${method === 'goto' ? 'Open' : 'Wait for the page URL to match'} ${target.text}${options}`)
  },
}

const INTERACTION_RULE: ActionRule = {
  methods: new Set(['click', 'dblclick', 'tap', 'hover', 'focus', 'fill', 'clear', 'check', 'uncheck', 'selectOption', 'setInputFiles', 'press', 'pressSequentially', 'type']),
  matches(context) {
    return Boolean(renderLocator(context.receiver, context.sourceFile)) || isPageReceiver(context)
  },
  render(context) {
    const { call, method, sourceFile } = context
    const targetInfo = locatorTarget(context)
    if (!targetInfo || targetInfo.target.fidelity === 'unresolved') return sourceFallback(call, sourceFile)
    const { target, argumentOffset } = targetInfo
    const valueMethods = new Set(['fill', 'selectOption', 'setInputFiles', 'press', 'pressSequentially', 'type'])
    const value = valueMethods.has(method) ? safeExpression(call.arguments[argumentOffset], sourceFile) : undefined
    if (valueMethods.has(method) && (!value || value.fidelity === 'unresolved')) return sourceFallback(call, sourceFile)
    const options = safeOptions(call, argumentOffset + (value ? 1 : 0), sourceFile)
    if (options === null) return sourceFallback(call, sourceFile)

    const simpleVerbs: Record<string, string> = {
      click: 'Click',
      dblclick: 'Double-click',
      tap: 'Tap',
      hover: 'Point at',
      focus: 'Focus',
      clear: 'Clear',
      check: 'Check',
      uncheck: 'Uncheck',
    }
    if (simpleVerbs[method]) return action(`${simpleVerbs[method]} ${target.text}${options}`)
    if (method === 'fill') return action(`Enter ${value?.text} in ${target.text}${options}`)
    if (method === 'selectOption') return action(`Select ${value?.text} in ${target.text}${options}`)
    if (method === 'setInputFiles') return action(`Upload ${value?.text} using ${target.text}${options}`)
    if (method === 'press') return action(`Press ${value?.text} on ${target.text}${options}`)
    return action(`Type ${value?.text} into ${target.text}${options}`)
  },
}

const KEYBOARD_RULE: ActionRule = {
  methods: new Set(['press', 'type', 'insertText']),
  matches: isKeyboardReceiver,
  render(context) {
    const value = safeExpression(context.call.arguments[0], context.sourceFile)
    const options = safeOptions(context.call, 1, context.sourceFile)
    if (!value || value.fidelity === 'unresolved' || options === null) return sourceFallback(context.call, context.sourceFile)
    return action(`${context.method === 'press' ? 'Press' : 'Type'} ${value.text} with the keyboard${options}`)
  },
}

const WAIT_RULE: ActionRule = {
  methods: new Set(['waitFor', 'waitForTimeout', 'waitForSelector', 'waitForRequest', 'waitForResponse']),
  matches(context) {
    return context.method === 'waitFor'
      ? Boolean(renderLocator(context.receiver, context.sourceFile))
      : isPageReceiver(context)
  },
  render(context) {
    const { call, method, sourceFile } = context
    if (method === 'waitFor') {
      const target = renderLocator(context.receiver, sourceFile)
      const options = safeOptions(call, 0, sourceFile)
      if (!target || target.fidelity === 'unresolved' || options === null) return sourceFallback(call, sourceFile)
      return action(`Wait for ${target.text}${options}`)
    }
    const value = safeExpression(call.arguments[0], sourceFile)
    if (!value || value.fidelity === 'unresolved') return sourceFallback(call, sourceFile)
    const options = safeOptions(call, 1, sourceFile)
    if (options === null) return sourceFallback(call, sourceFile)
    if (method === 'waitForTimeout') return action(`Wait for ${value.text} milliseconds`)
    if (method === 'waitForSelector') return action(`Wait for the element matching ${value.text}${options}`)
    const noun = method === 'waitForRequest' ? 'request' : 'response'
    return action(`Wait for the ${noun} matching ${value.text}${options}`)
  },
}

const REQUEST_RULE: ActionRule = {
  methods: new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']),
  matches: isRequestReceiver,
  render(context) {
    const url = safeExpression(context.call.arguments[0], context.sourceFile)
    const options = safeOptions(context.call, 1, context.sourceFile)
    if (!url || url.fidelity === 'unresolved' || options === null) return sourceFallback(context.call, context.sourceFile)
    return action(`Send a ${context.method.toUpperCase()} request to ${url.text}${options}`)
  },
}

const SETUP_RULE: ActionRule = {
  methods: new Set(['route', 'unroute', 'addInitScript', 'setExtraHTTPHeaders', 'setViewportSize', 'emulateMedia', 'addCookies']),
  matches() {
    return true
  },
  render(context) {
    const { call, method, sourceFile } = context
    if (method === 'addInitScript') return setup('Add a browser initialization script')
    const value = safeExpression(call.arguments[0], sourceFile)
    if (!value || value.fidelity === 'unresolved') return sourceFallback(call, sourceFile)
    if (method === 'route' || method === 'unroute') {
      return setup(`${method === 'route' ? 'Intercept' : 'Stop intercepting'} requests matching ${value.text}${method === 'route' ? ' using the authored route handler' : ''}`)
    }
    if (method === 'setExtraHTTPHeaders') return setup(`Set extra HTTP headers to ${value.text}`)
    if (method === 'setViewportSize') return setup(`Set the browser viewport to ${value.text}`)
    if (method === 'emulateMedia') return setup(`Set browser media preferences to ${value.text}`)
    return setup(`Add cookies from ${value.text}`)
  },
}

const TEST_CONTROL_RULE: ActionRule = {
  methods: new Set(['skip', 'fixme', 'fail', 'slow', 'setTimeout', 'use']),
  matches(context) {
    return expressionPath(context.receiver) === 'test'
  },
  render(context) {
    if (context.method === 'skip') return renderSkipControl(context)
    if (context.method === 'fixme') return setup('Mark this scenario as needing repair')
    if (context.method === 'fail') return setup('Expect this scenario to fail')
    if (context.method === 'slow') return setup('Allow extra time for this scenario')
    if (context.method === 'setTimeout') {
      const [duration, ...extra] = context.call.arguments
      if (!duration || extra.length) return sourceFallback(context.call, context.sourceFile)
      const rendered = renderExpression(duration, context.sourceFile)
      if (rendered.fidelity === 'unresolved') return sourceFallback(context.call, context.sourceFile)
      // A bare number is unit-less on its own; a named expression carries its
      // meaning already (`interactive timeout ms plus 60000`).
      return setup(`Allow ${rendered.text}${ts.isNumericLiteral(duration) ? ' milliseconds' : ''} for this scenario`)
    }
    const fixtures = safeExpression(context.call.arguments[0], context.sourceFile)
    return fixtures && fixtures.fidelity !== 'unresolved'
      ? setup(`Configure test fixtures using ${fixtures.text}`)
      : sourceFallback(context.call, context.sourceFile)
  },
}

/** `test.skip(condition, reason)` guards a scenario on missing setup — name
 *  the condition variable and keep the authored reason instead of a generic
 *  "required test setup is missing" sentence that hides which variable it is. */
function renderSkipControl(context: CallContext): RenderedAction {
  const [condition, reason, ...extra] = context.call.arguments
  if (extra.length) return sourceFallback(context.call, context.sourceFile)
  if (!condition) return setup('Skip this scenario')
  const conditionText = renderSkipCondition(condition, context.sourceFile)
  if (!reason) {
    return conditionText ? setup(`Skip this scenario when ${conditionText}`) : sourceFallback(context.call, context.sourceFile)
  }
  const reasonRendered = renderExpression(reason, context.sourceFile)
  if (reasonRendered.fidelity === 'unresolved') return sourceFallback(context.call, context.sourceFile)
  if (conditionText) return setup(`Skip this scenario when ${conditionText} — ${reasonRendered.text}`)
  // The condition doesn't render (usually a call like `!isSyncSqlConfigured()`)
  // but an authored reason string explains the skip in the writer's own words.
  if (ts.isStringLiteralLike(reason)) return setup(`Skip this scenario — ${reasonRendered.text}`)
  return sourceFallback(context.call, context.sourceFile)
}

function renderSkipCondition(condition: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  // `test.skip(!token, …)` is the missing-setup idiom — say which variable is missing.
  if (
    ts.isPrefixUnaryExpression(condition)
    && condition.operator === ts.SyntaxKind.ExclamationToken
    && (ts.isIdentifier(condition.operand) || ts.isPropertyAccessExpression(condition.operand))
  ) {
    const subject = renderExpression(condition.operand, sourceFile)
    if (subject.fidelity !== 'unresolved') return `${subject.text} is missing`
  }
  const rendered = renderExpression(condition, sourceFile)
  return rendered.fidelity === 'unresolved' ? undefined : rendered.text
}

/** Zero-argument lifecycle calls — `await ctx.session.close()`,
 *  `callbackServer.start()` — read as the capitalized verb applied to the
 *  receiver's own name; the tail of a dotted path is the noun a reader knows
 *  the object by. Calls with arguments stay as source: an argument changes
 *  what the call does, and naming the verb alone would hide it. */
const LIFECYCLE_RULE: ActionRule = {
  methods: new Set(['start', 'stop', 'close', 'disconnect', 'dispose']),
  matches(context) {
    return context.call.arguments.length === 0
  },
  render(context) {
    const path = expressionPath(context.receiver)
    if (!path) return sourceFallback(context.call, context.sourceFile)
    const noun = humanizeIdentifier(path.slice(path.lastIndexOf('.') + 1))
    return action(`${sentenceCase(context.method)} the ${noun}`)
  },
}

const CONSOLE_RULE: ActionRule = {
  methods: new Set(['log', 'info', 'warn', 'error', 'debug']),
  matches(context) {
    return expressionPath(context.receiver) === 'console'
  },
  render(context) {
    const rendered = context.call.arguments.map((argument) => renderExpression(argument, context.sourceFile))
    if (rendered.some((argument) => argument.fidelity === 'unresolved')) return sourceFallback(context.call, context.sourceFile)
    if (!rendered.length) return action('Log an empty line to the console')
    return action(`Log ${rendered.map((argument) => argument.text).join(' and ')} to the console`)
  },
}

const ACTION_RULES: ActionRule[] = [
  NAVIGATION_RULE,
  KEYBOARD_RULE,
  INTERACTION_RULE,
  WAIT_RULE,
  REQUEST_RULE,
  TEST_CONTROL_RULE,
  CONSOLE_RULE,
  SETUP_RULE,
  // Last: any specific rule above owns its methods first (none overlap today,
  // but a future `page.close(options)` variant must never be shadowed).
  LIFECYCLE_RULE,
]

function callFromExpression(expression: ts.Expression): ts.CallExpression | undefined {
  let current = expression
  while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression
  return ts.isCallExpression(current) ? current : undefined
}

function callFromStatement(statement: ts.Statement): ts.CallExpression | undefined {
  if (ts.isExpressionStatement(statement)) return callFromExpression(statement.expression)
  if (ts.isReturnStatement(statement) && statement.expression) return callFromExpression(statement.expression)
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const initializer = statement.declarationList.declarations[0].initializer
    return initializer ? callFromExpression(initializer) : undefined
  }
  return undefined
}

const CALL_FREE_ASSIGNMENT_TEXT = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.EqualsToken, 'Set {target} to {value}'],
  [ts.SyntaxKind.PlusEqualsToken, 'Increase {target} by {value}'],
  [ts.SyntaxKind.MinusEqualsToken, 'Decrease {target} by {value}'],
])

/** `await new Promise((r) => setTimeout(r, 3000))` is the bare-sleep idiom —
 *  worth naming because it reads as noise otherwise. Only the exact shape
 *  qualifies: one arrow whose concise body resolves its own parameter after a
 *  literal delay. Anything looser could be a real executor doing work. */
function sleepDelayMs(expression: ts.Expression): string | undefined {
  let node = expression
  while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'Promise') return undefined
  const [executor, ...extraArgs] = node.arguments ?? []
  if (!executor || extraArgs.length || !ts.isArrowFunction(executor)) return undefined
  const parameter = executor.parameters.length === 1 ? executor.parameters[0].name : undefined
  if (!parameter || !ts.isIdentifier(parameter) || ts.isBlock(executor.body)) return undefined
  const body = executor.body
  if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression) || body.expression.text !== 'setTimeout') return undefined
  const [callback, delay, ...extra] = body.arguments
  if (!delay || extra.length) return undefined
  if (!ts.isIdentifier(callback) || callback.text !== parameter.text || !ts.isNumericLiteral(delay)) return undefined
  return delay.text
}

/** Statements no method rule dispatched — plain declarations, assignments,
 *  deletes, throws, and returns — still read as steps when both sides render. */
function renderCallFreeStatement(statement: ts.Statement, sourceFile: ts.SourceFile): RenderedAction | undefined {
  if (ts.isReturnStatement(statement)) {
    if (!statement.expression) return undefined
    const value = renderExpression(statement.expression, sourceFile)
    if (value.fidelity === 'unresolved') return undefined
    return action(`Return ${value.text}`)
  }
  if (ts.isThrowStatement(statement)) {
    // `throw error` inside a catch is a rethrow; `throw new Error('…')` with an
    // authored message keeps the writer's words. Computed messages stay source.
    if (ts.isIdentifier(statement.expression)) return action(`Rethrow the ${humanizeIdentifier(statement.expression.text)}`)
    if (
      ts.isNewExpression(statement.expression)
      && ts.isIdentifier(statement.expression.expression)
      && statement.expression.expression.text === 'Error'
    ) {
      const [message, ...extra] = statement.expression.arguments ?? []
      if (message && !extra.length && ts.isStringLiteralLike(message)) {
        return action(`Fail with ${renderExpression(message, sourceFile).text}`)
      }
    }
    return undefined
  }
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const declaration = statement.declarationList.declarations[0]
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined
    const value = renderExpression(declaration.initializer, sourceFile)
    if (value.fidelity === 'unresolved') return undefined
    return setup(`Set ${humanizeIdentifier(declaration.name.text)} to ${value.text}`)
  }
  if (!ts.isExpressionStatement(statement)) return undefined
  const expression = statement.expression
  const sleepMs = sleepDelayMs(expression)
  if (sleepMs !== undefined) return action(`Wait for ${sleepMs} milliseconds`)
  if (ts.isDeleteExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const owner = renderExpression(expression.expression.expression, sourceFile)
    if (owner.fidelity === 'unresolved') return undefined
    return action(`Remove “${expression.expression.name.text}” from ${owner.text}`)
  }
  if (ts.isBinaryExpression(expression)) {
    const wording = CALL_FREE_ASSIGNMENT_TEXT.get(expression.operatorToken.kind)
    if (!wording) return undefined
    const target = renderExpression(expression.left, sourceFile)
    const value = renderExpression(expression.right, sourceFile)
    if (target.fidelity === 'unresolved' || value.fidelity === 'unresolved') return undefined
    return action(wording.replace('{target}', target.text).replace('{value}', value.text))
  }
  return undefined
}

export function renderActionStatement(statement: ts.Statement, sourceFile: ts.SourceFile): RenderedAction | undefined {
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    let initializer = statement.declarationList.declarations[0].initializer
    while (initializer && (ts.isAwaitExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression
    if (
      initializer
      && ts.isNewExpression(initializer)
      && ts.isIdentifier(initializer.expression)
      && initializer.expression.text === 'Date'
      && !(initializer.arguments ?? []).length
    ) {
      return action('Record the start time')
    }
  }
  const call = callFromStatement(statement)
  if (!call) return renderCallFreeStatement(statement, sourceFile)
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined
  const context: CallContext = {
    call,
    method: call.expression.name.text,
    receiver: call.expression.expression,
    sourceFile,
  }
  const rule = ACTION_RULES.find((candidate) => candidate.methods.has(context.method) && candidate.matches(context))
  // A method call outside the rule tables can still be a readable declaration
  // or return — `const body = await res.json()`, `return { res, elapsedMs }` —
  // because the expression layer knows the call even though no action rule does.
  return rule?.render(context) ?? renderCallFreeStatement(statement, sourceFile)
}
