import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import type { ReadableFidelity } from '../../../../../shared/readable-tests/types'
import { renderExpression, type RenderedExpression } from './expression'

interface StaticOption {
  name: string
  value: ts.Expression
}

function fallback(node: ts.Node, sourceFile: ts.SourceFile): RenderedExpression {
  return {
    text: formatSourceSnippetForDisplay(node.getText(sourceFile)),
    fidelity: 'unresolved',
  }
}

function optionsFrom(argument: ts.Expression | undefined): StaticOption[] | null {
  if (!argument) return []
  if (!ts.isObjectLiteralExpression(argument)) return null
  const options: StaticOption[] = []
  for (const property of argument.properties) {
    if (!ts.isPropertyAssignment(property)) return null
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
      ? property.name.text
      : undefined
    if (!name) return null
    options.push({ name, value: property.initializer })
  }
  return options
}

function booleanValue(node: ts.Expression): boolean | undefined {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  return undefined
}

function optionValue(options: StaticOption[], name: string): ts.Expression | undefined {
  return options.find((option) => option.name === name)?.value
}

function renderArgument(node: ts.Expression | undefined, sourceFile: ts.SourceFile): RenderedExpression | undefined {
  if (!node) return undefined
  return renderExpression(node, sourceFile)
}

function withScope(text: string, receiver: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  if (ts.isIdentifier(receiver) && (receiver.text === 'page' || receiver.text === 'frame')) {
    return { text, fidelity: 'derived' }
  }
  const locator = renderLocator(receiver, sourceFile)
  if (locator) {
    return locator.fidelity === 'unresolved'
      ? locator
      : { text: `${text} inside ${locator.text}`, fidelity: 'derived' }
  }
  const owner = renderExpression(receiver, sourceFile)
  return owner.fidelity === 'unresolved'
    ? { text, fidelity: 'derived' }
    : { text: `${text} inside ${owner.text}`, fidelity: 'derived' }
}

function exactQualifier(options: StaticOption[], sourceFile: ts.SourceFile): string | null {
  const exact = optionValue(options, 'exact')
  if (!exact) return ''
  const value = booleanValue(exact)
  if (value === undefined) return null
  return value ? ' using an exact match' : ''
}

function renderRoleLocator(call: ts.CallExpression, receiver: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  const role = renderArgument(call.arguments[0], sourceFile)
  const options = optionsFrom(call.arguments[1])
  if (!role || role.fidelity === 'unresolved' || !options) return fallback(call, sourceFile)
  const allowed = new Set(['name', 'exact', 'checked', 'disabled', 'expanded', 'includeHidden', 'level', 'pressed', 'selected'])
  if (options.some((option) => !allowed.has(option.name))) return fallback(call, sourceFile)

  const name = renderArgument(optionValue(options, 'name'), sourceFile)
  if (name?.fidelity === 'unresolved') return fallback(call, sourceFile)
  const exact = exactQualifier(options, sourceFile)
  if (exact === null) return fallback(call, sourceFile)
  const literalRole = ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].text : undefined
  let text = literalRole
    ? (name ? `the ${name.text} ${literalRole}` : `the ${literalRole}`)
    : `the element with role ${role.text}${name ? ` named ${name.text}` : ''}`

  const booleanQualifiers: Array<[string, string, string]> = [
    ['checked', 'checked', 'not checked'],
    ['disabled', 'disabled', 'not disabled'],
    ['expanded', 'expanded', 'collapsed'],
    ['pressed', 'pressed', 'not pressed'],
    ['selected', 'selected', 'not selected'],
  ]
  for (const [optionName, whenTrue, whenFalse] of booleanQualifiers) {
    const option = optionValue(options, optionName)
    if (!option) continue
    const value = booleanValue(option)
    if (value === undefined) return fallback(call, sourceFile)
    text += ` that is ${value ? whenTrue : whenFalse}`
  }
  const level = optionValue(options, 'level')
  if (level) {
    if (!ts.isNumericLiteral(level)) return fallback(call, sourceFile)
    text += ` at level ${level.text}`
  }
  const includeHidden = optionValue(options, 'includeHidden')
  if (includeHidden) {
    const value = booleanValue(includeHidden)
    if (value === undefined) return fallback(call, sourceFile)
    if (value) text += ', including hidden elements'
  }
  return withScope(`${text}${exact}`, receiver, sourceFile)
}

function renderNamedLocator(
  call: ts.CallExpression,
  receiver: ts.Expression,
  sourceFile: ts.SourceFile,
  noun: string,
  allowedOptions: string[] = ['exact'],
): RenderedExpression {
  const value = renderArgument(call.arguments[0], sourceFile)
  const options = optionsFrom(call.arguments[1])
  if (!value || value.fidelity === 'unresolved' || !options) return fallback(call, sourceFile)
  if (options.some((option) => !allowedOptions.includes(option.name))) return fallback(call, sourceFile)
  const exact = exactQualifier(options, sourceFile)
  if (exact === null) return fallback(call, sourceFile)
  return withScope(`${noun} ${value.text}${exact}`, receiver, sourceFile)
}

function renderPositionedLocator(call: ts.CallExpression, receiver: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression | undefined {
  const base = renderLocator(receiver, sourceFile)
  if (!base) return undefined
  if (base.fidelity === 'unresolved') return base
  const method = (call.expression as ts.PropertyAccessExpression).name.text
  if (method === 'first' && call.arguments.length === 0) {
    return { text: `the first match for ${base.text}`, fidelity: 'derived' }
  }
  if (method === 'last' && call.arguments.length === 0) {
    return { text: `the last match for ${base.text}`, fidelity: 'derived' }
  }
  if (method === 'nth' && call.arguments.length === 1) {
    const index = renderExpression(call.arguments[0], sourceFile)
    return index.fidelity === 'unresolved'
      ? fallback(call, sourceFile)
      : { text: `the match at zero-based index ${index.text} for ${base.text}`, fidelity: 'derived' }
  }
  return fallback(call, sourceFile)
}

/** Returns undefined when the expression is not a recognized Playwright locator. */
export function renderLocator(node: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined
  const method = node.expression.name.text
  const receiver = node.expression.expression

  if (method === 'getByRole') return renderRoleLocator(node, receiver, sourceFile)
  if (method === 'getByLabel') return renderNamedLocator(node, receiver, sourceFile, 'the control labelled')
  if (method === 'getByText') return renderNamedLocator(node, receiver, sourceFile, 'the text')
  if (method === 'getByTestId') return renderNamedLocator(node, receiver, sourceFile, 'the element with test ID', [])
  if (method === 'getByPlaceholder') return renderNamedLocator(node, receiver, sourceFile, 'the field with placeholder')
  if (method === 'locator') return renderNamedLocator(node, receiver, sourceFile, 'the element matching', [])
  if (method === 'first' || method === 'last' || method === 'nth') {
    return renderPositionedLocator(node, receiver, sourceFile)
  }
  return undefined
}

export function locatorFidelity(locator: RenderedExpression): ReadableFidelity {
  return locator.fidelity === 'unresolved' ? 'unresolved' : 'derived'
}
