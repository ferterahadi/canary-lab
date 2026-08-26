import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import type { ReadableFidelity, ReadableLeafRole } from '../../../../../shared/readable-tests/types'
import { renderExpression, type RenderedExpression } from './expression'
import { renderLocator } from './locator'

export interface RenderedAction {
  text: string
  fidelity: ReadableFidelity
  role: ReadableLeafRole
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

function expressionPath(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) {
    const owner = expressionPath(node.expression)
    return owner ? `${owner}.${node.name.text}` : undefined
  }
  return undefined
}

function isPageReceiver(context: CallContext): boolean {
  return expressionPath(context.receiver)?.split('.').at(-1) === 'page'
}

function isKeyboardReceiver(context: CallContext): boolean {
  return expressionPath(context.receiver)?.endsWith('.keyboard') ?? false
}

function isRequestReceiver(context: CallContext): boolean {
  const receiver = expressionPath(context.receiver)?.split('.').at(-1)?.toLowerCase()
  return receiver === 'request' || receiver === 'api' || receiver === 'apirequest' || receiver === 'requestcontext'
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
  methods: new Set(['skip', 'fixme', 'fail', 'slow', 'use']),
  matches(context) {
    return expressionPath(context.receiver) === 'test'
  },
  render(context) {
    if (context.method === 'skip') return setup('Skip if required test setup is missing')
    if (context.method === 'fixme') return setup('Mark this scenario as needing repair')
    if (context.method === 'fail') return setup('Expect this scenario to fail')
    if (context.method === 'slow') return setup('Allow extra time for this scenario')
    const fixtures = safeExpression(context.call.arguments[0], context.sourceFile)
    return fixtures && fixtures.fidelity !== 'unresolved'
      ? setup(`Configure test fixtures using ${fixtures.text}`)
      : sourceFallback(context.call, context.sourceFile)
  },
}

const ACTION_RULES: ActionRule[] = [
  NAVIGATION_RULE,
  KEYBOARD_RULE,
  INTERACTION_RULE,
  WAIT_RULE,
  REQUEST_RULE,
  TEST_CONTROL_RULE,
  SETUP_RULE,
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

export function renderActionStatement(statement: ts.Statement, sourceFile: ts.SourceFile): RenderedAction | undefined {
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    let initializer = statement.declarationList.declarations[0].initializer
    while (initializer && (ts.isAwaitExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression
    if (
      initializer
      && ts.isNewExpression(initializer)
      && ts.isIdentifier(initializer.expression)
      && initializer.expression.text === 'Date'
    ) {
      return action('Record the start time')
    }
  }
  const call = callFromStatement(statement)
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return undefined
  const context: CallContext = {
    call,
    method: call.expression.name.text,
    receiver: call.expression.expression,
    sourceFile,
  }
  const rule = ACTION_RULES.find((candidate) => candidate.methods.has(context.method) && candidate.matches(context))
  return rule?.render(context)
}
