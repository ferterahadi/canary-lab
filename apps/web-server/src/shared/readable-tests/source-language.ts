import ts from 'typescript'
import { BINARY_OPERATOR_PHRASES, expressionEnglish, parameterEnglish, statementEnglish, statementHeaderEnglish, typeEnglish } from '../controlled-english/ast-to-ir'
import { renderEnglish } from '../controlled-english/english-renderer'
import { symbolEvidence, type SemanticContext } from '../controlled-english/semantic-context'
import { ASSERTION_RULES } from '../controlled-english/structured-english'
import { parseExpectation } from './assertions'

const COMPARISON_OPERATORS = new Set([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword])

export function sourceExpressionText(node: ts.Expression): string {
  if (ts.isStringLiteral(node)) return JSON.stringify(node.text)
  if (ts.isNoSubstitutionTemplateLiteral(node)) return `template text ${JSON.stringify(node.text)}`
  if (ts.isTemplateExpression(node)) {
    const parts = [...(node.head.text ? [JSON.stringify(node.head.text)] : []),
      ...node.templateSpans.flatMap((span) => [sourceArgumentText(span.expression), ...(span.literal.text ? [JSON.stringify(span.literal.text)] : [])])]
    return `text formed by joining ${parts.join(', ')}`
  }
  if (ts.isIdentifier(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) return node.getText()
  if (ts.isParenthesizedExpression(node)) return `(${sourceExpressionText(node.expression)})`
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) return simpleReference(node.expression)
    ? `${sourceExpressionText(node.expression)}.${node.name.text}` : `${node.name.text} from ${sourceArgumentText(node.expression)}`
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.length ? `a list containing ${node.elements.map((item) => ts.isSpreadElement(item)
      ? `all items from ${sourceArgumentText(item.expression)}` : ts.isOmittedExpression(item) ? 'an empty slot' : sourceArgumentText(item)).join(', ')}` : 'an empty list'
  }
  if (ts.isSpreadElement(node)) return `each item from ${sourceArgumentText(node.expression)} as a separate argument`
  if (ts.isCallExpression(node) && !node.questionDotToken && !node.typeArguments?.length) {
    return `the result of ${callTargetText(node.expression)}${node.arguments.length ? ` with ${node.arguments.map(sourceArgumentText).join(', ')}` : '()'}`
  }
  if (ts.isAwaitExpression(node)) {
    const value = sourceExpressionText(node.expression)
    return value.startsWith('the result of ') ? `the awaited result of ${value.slice('the result of '.length)}` : `the awaited value of ${value}`
  }
  const properties = ts.isObjectLiteralExpression(node) ? [...node.properties] : undefined
  if (properties && properties.every((property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment | ts.SpreadAssignment => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isSpreadAssignment(property))) {
    if (!properties.length) return 'an empty object'
    return `an object with ${properties.map((property) => ts.isSpreadAssignment(property) ? `all properties copied from ${sourceArgumentText(property.expression)}` : ts.isPropertyAssignment(property)
      ? `${ts.isComputedPropertyName(property.name) ? `the property named by ${sourceArgumentText(property.name.expression)}` : property.name.getText()} set to ${sourceArgumentText(property.initializer)}`
      : `shorthand property ${property.name.text}${property.objectAssignmentInitializer ? ` defaulting to ${sourceExpressionText(property.objectAssignmentInitializer)}` : ''}`).join('; ')}`
  }
  if (ts.isConditionalExpression(node)) return `(${sourceExpressionText(node.whenTrue)} if ${sourceConditionText(node.condition)}; otherwise ${sourceExpressionText(node.whenFalse)})`
  if (ts.isArrowFunction(node) && !node.typeParameters?.length) {
    const asynchronous = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    const parameters = node.parameters.length ? `receiving ${node.parameters.map(sourceParameterText).join(', ')}` : 'with no parameters'
    const signature = `an ${asynchronous ? 'asynchronous ' : ''}arrow function ${parameters}${node.type ? ` with return type ${renderEnglish(typeEnglish(node.type))}` : ''}`
    if (ts.isBlock(node.body)) return `${signature} that runs these statements when called:\n${indentText(callbackStatementText(node.body))}`
    const comparison = ts.isBinaryExpression(node.body) && COMPARISON_OPERATORS.has(node.body.operatorToken.kind)
    return `${signature} that returns ${comparison ? 'whether ' : ''}${sourceExpressionText(node.body)}`
  }
  if (ts.isBinaryExpression(node)) {
    const operator = BINARY_OPERATOR_PHRASES.get(node.operatorToken.kind)
    if (operator) return `${sourceArgumentText(node.left)} ${operator} ${sourceArgumentText(node.right)}`
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return `not (${sourceExpressionText(node.operand)})`
  }
  return renderEnglish(expressionEnglish(node))
}

function simpleReference(node: ts.Expression): boolean {
  return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword
    || ts.isPropertyAccessExpression(node) && !node.questionDotToken && simpleReference(node.expression)
}

function callTargetText(node: ts.Expression): string {
  return ts.isPropertyAccessExpression(node) && !node.questionDotToken && !simpleReference(node.expression)
    ? `${node.name.text} on (${sourceExpressionText(node.expression)})` : sourceArgumentText(node)
}

/** Ordinary arrows already have a complete natural rendering. Other
 * callbacks retain the full grammar until their signatures and bodies can be
 * represented without losing any authored syntax. */
export function hasStructuralCallback(node: ts.Node): boolean {
  if (ts.isFunctionExpression(node)) return true
  if (ts.isArrowFunction(node) && node.typeParameters?.length) return true
  let found = false
  node.forEachChild((child) => { if (hasStructuralCallback(child)) found = true })
  return found
}

function indentText(text: string): string {
  return text.split('\n').map((line) => `  ${line}`).join('\n')
}

function callbackStatementText(node: ts.Statement): string {
  if (ts.isBlock(node)) return node.statements.length ? node.statements.map(callbackStatementText).join('\n') : 'Do nothing.'
  if (ts.isIfStatement(node)) return `If ${sourceConditionText(node.expression)}:\n${indentText(callbackStatementText(node.thenStatement))}`
    + (node.elseStatement ? `\nElse:\n${indentText(callbackStatementText(node.elseStatement))}` : '')
  return sourceAssertionText(node) ?? sourceDeclarationText(node) ?? sourceStatementText(node) ?? renderEnglish(statementEnglish(node))
}

/** Explicit grouping prevents nested argument/property lists from merging. */
function sourceArgumentText(node: ts.Expression): string {
  const text = sourceExpressionText(node)
  return ts.isCallExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
    || ts.isArrowFunction(node) || ts.isAwaitExpression(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node)
    ? `(${text})` : text
}

function sourceParameterText(node: ts.ParameterDeclaration): string {
  if (!node.modifiers?.length && !node.dotDotDotToken && !node.questionToken && !node.initializer) {
    const type = node.type ? ` of type ${renderEnglish(typeEnglish(node.type))}` : ''
    if (ts.isIdentifier(node.name)) return `${node.name.text}${type}`
    if (ts.isObjectBindingPattern(node.name) && node.name.elements.every((binding) => !binding.dotDotDotToken && !binding.propertyName && !binding.initializer && ts.isIdentifier(binding.name))) {
      return `an object with properties ${node.name.elements.map((binding) => binding.name.getText()).join(', ')}${type}`
    }
  }
  return renderEnglish(parameterEnglish(node))
}

export function sourceFunctionText(node: ts.FunctionDeclaration): string {
  if (!node.name || node.typeParameters?.length || node.modifiers?.some((modifier) => modifier.kind !== ts.SyntaxKind.AsyncKeyword)) {
    return renderEnglish(statementHeaderEnglish(node))
  }
  const asynchronous = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  return `Define ${asynchronous ? 'asynchronous ' : ''}${node.asteriskToken ? 'generator ' : ''}function ${node.name.text}`
    + (node.parameters.length ? `, taking ${node.parameters.map(sourceParameterText).join('; ')}` : ' with no parameters')
    + (node.type ? `, with return type ${renderEnglish(typeEnglish(node.type))}` : '')
    + (node.body ? '' : ', with no body')
}

export function sourceConditionText(node: ts.Expression): string {
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return `${sourceExpressionText(node.operand)} is falsy`
  if (ts.isBinaryExpression(node) && COMPARISON_OPERATORS.has(node.operatorToken.kind)) return sourceExpressionText(node)
  return `${sourceExpressionText(node)} is truthy`
}

export function sourceLoopText(node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement | ts.WhileStatement | ts.DoStatement): string {
  if (ts.isWhileStatement(node)) return `While ${sourceConditionText(node.expression)}; this may run zero times`
  if (ts.isDoStatement(node)) return `Run once, then repeat while ${sourceConditionText(node.expression)}`
  if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
    const bindings = node.initializer.declarations
    if (bindings.length === 1 && ts.isIdentifier(bindings[0].name) && !bindings[0].type && !bindings[0].initializer && !(node.initializer.flags & ts.NodeFlags.Using)) {
      const kind = node.initializer.flags & ts.NodeFlags.Const ? 'constant' : node.initializer.flags & ts.NodeFlags.Let ? 'variable' : 'function-scoped variable'
      if (ts.isForOfStatement(node) && ts.isArrayLiteralExpression(node.expression) && node.expression.elements.some(ts.isSpreadElement)) {
        return `Build this list in order, then process each item as ${kind} ${bindings[0].name.text}${node.awaitModifier ? ', awaiting each item' : ''}:\n`
          + node.expression.elements.map((item, index) => `${index + 1}. ${listEntryText(item)}`).join('\n')
      }
      const source = sourceExpressionText(node.expression)
      return ts.isForInStatement(node)
        ? `For each enumerable property key in ${source}, bind ${kind} ${bindings[0].name.text}`
        : `For each value in ${source}, bind ${kind} ${bindings[0].name.text}${node.awaitModifier ? ', awaiting each value' : ''}`
    }
  }
  return renderEnglish(statementHeaderEnglish(node))
}

function listEntryText(node: ts.Expression): string {
  if (!ts.isSpreadElement(node)) return ts.isOmittedExpression(node) ? 'Leave an empty slot.' : `Include ${sourceExpressionText(node)}.`
  let value = node.expression
  while (ts.isParenthesizedExpression(value)) value = value.expression
  if (ts.isConditionalExpression(value)) {
    const emptyOtherwise = ts.isArrayLiteralExpression(value.whenFalse) && value.whenFalse.elements.length === 0
    return `If ${sourceConditionText(value.condition)}, include all items from ${sourceArgumentText(value.whenTrue)}; otherwise ${emptyOtherwise ? 'include no items' : `include all items from ${sourceArgumentText(value.whenFalse)}`}.`
  }
  return `Include all items from ${sourceArgumentText(node.expression)}.`
}

export function sourceStatementText(node: ts.Statement): string | undefined {
  if (ts.isReturnStatement(node)) return node.expression ? `Return ${sourceExpressionText(node.expression)}` : 'Return without a value'
  if (ts.isThrowStatement(node)) return `Throw ${sourceExpressionText(node.expression)}`
  if (!ts.isExpressionStatement(node)) return undefined
  const expression = node.expression
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return `Set ${sourceExpressionText(expression.left)} to ${sourceExpressionText(expression.right)}`
  }
  if (ts.isCallExpression(expression) || ts.isAwaitExpression(expression)) {
    const call = ts.isAwaitExpression(expression) ? expression.expression : expression
    if (!ts.isCallExpression(call) || call.questionDotToken || call.typeArguments?.length) return ts.isAwaitExpression(expression)
      ? `Wait for ${sourceExpressionText(call)}` : sourceExpressionText(expression)
    const target = callTargetText(call.expression)
    const wait = ts.isAwaitExpression(expression) ? ' and wait for it to finish' : ''
    if (call.arguments.some(ts.isArrowFunction)) {
      return `Call ${target}${wait}. Pass these arguments in order:\n`
        + call.arguments.map((argument, index) => `${index + 1}. ${sourceExpressionText(argument)}`).join('\n')
    }
    return `Call ${target}${call.arguments.length ? ` with ${call.arguments.map(sourceArgumentText).join(', ')}` : ' with no arguments'}${wait}`
  }
  return undefined
}

export function sourceAssertionText(node: ts.Statement): string | undefined {
  if (!ts.isExpressionStatement(node)) return undefined
  const awaited = ts.isAwaitExpression(node.expression)
  const expression = awaited ? node.expression.expression : node.expression
  if (!ts.isCallExpression(expression) || expression.typeArguments?.length || expression.questionDotToken) return undefined
  const expectation = parseExpectation(expression)
  if (!expectation) return undefined
  const rule = ASSERTION_RULES.find((rule) => rule.matcher === expectation.matcher)
  if (!rule || expression.arguments.length < rule.expectedArguments) return undefined
  const subject = sourceExpressionText(expectation.actual)
  const settled = expectation.settlement === 'resolves' ? `the resolved value of ${subject}`
    : expectation.settlement === 'rejects' ? `the rejection from ${subject}` : subject
  const expected = rule.expectedArguments ? ` ${sourceArgumentText(expression.arguments[0])}` : ''
  const extra = expression.arguments.slice(rule.expectedArguments)
  return `${awaited ? 'Wait for the check' : 'Check'} that ${settled} ${expectation.negated ? rule.negatedRelation : rule.relation}${expected}`
    + (expectation.soft ? '; continue collecting failures if this check fails' : '')
    + (expectation.message ? `; with failure message ${sourceExpressionText(expectation.message)}` : '')
    + (extra.length ? `; with additional arguments ${extra.map(sourceArgumentText).join(', ')}` : '')
}
const HOOKS: Readonly<Record<string, string>> = {
  beforeAll: 'Before all tests', beforeEach: 'Before each test',
  afterAll: 'After all tests', afterEach: 'After each test',
}
const FRAMEWORKS = new Set(['@jest/globals', 'vitest', '@playwright/test', 'playwright/test', 'canary-lab/feature-support/log-marker-fixture'])
const TEST_NAMES = new Set(['test', 'it', 'describe', ...Object.keys(HOOKS)])
const MODIFIERS: Readonly<Record<string, string>> = {
  only: 'only', skip: 'skipped', todo: 'to do', concurrent: 'concurrent',
  serial: 'serial', parallel: 'parallel', failing: 'expected to fail', fixme: 'marked for fixing',
}

/** Syntax stays literal: names and types are preserved, never domain-inferred. */
export function sourceDeclarationText(node: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(node) && !node.attributes && ts.isStringLiteralLike(node.moduleSpecifier)) {
    const clause = node.importClause
    const module = JSON.stringify(node.moduleSpecifier.text)
    if (!clause) return `Load ${module} for its side effects`
    const bindings: string[] = []
    if (clause.name) bindings.push(`the default export as ${clause.name.text}`)
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) bindings.push(`all exports as ${clause.namedBindings.name.text}`)
      else for (const binding of clause.namedBindings.elements) {
        bindings.push(`${binding.isTypeOnly ? 'type ' : ''}${binding.propertyName ? `${binding.propertyName.text} as ` : ''}${binding.name.text}`)
      }
    }
    return `Import ${clause.isTypeOnly ? 'types ' : ''}${bindings.join(', ') || 'no bindings'} from ${module}`
  }
  if (ts.isVariableStatement(node)) {
    // Complex bindings and resource management retain the exhaustive grammar.
    if (node.modifiers?.length || node.declarationList.flags & ts.NodeFlags.Using
      || node.declarationList.declarations.some((binding) => !ts.isIdentifier(binding.name) || binding.exclamationToken)) {
      return renderEnglish(statementEnglish(node))
    }
    const kind = node.declarationList.flags & ts.NodeFlags.Const ? 'constant'
      : node.declarationList.flags & ts.NodeFlags.Let ? 'variable' : 'function-scoped variable'
    const declarations = node.declarationList.declarations.map((binding) => {
      const type = binding.type ? ` of type ${renderEnglish(typeEnglish(binding.type))}` : ''
      const value = binding.initializer ? ` to ${sourceExpressionText(binding.initializer)}` : ' without an initial value'
      return `${binding.initializer ? 'Set' : 'Declare'} ${kind} ${binding.name.getText()}${type}${value}`
    }).join('; ')
    return node.declarationList.declarations.length > 1 ? `In one declaration: ${declarations}` : declarations
  }
  return undefined
}

export function testRegistration(node: ts.Statement, context: SemanticContext): {
  text: string
  callback: ts.ArrowFunction | ts.FunctionExpression
} | undefined {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return undefined
  const call = node.expression
  if (call.questionDotToken || call.typeArguments?.length) return undefined
  const callbacks = call.arguments.filter((arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
  if (callbacks.length !== 1) return undefined
  const callback = callbacks[0]
  const path: string[] = []
  const tables: ts.Expression[] = []
  let callee = call.expression
  while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee) || ts.isTaggedTemplateExpression(callee)) {
    if (ts.isPropertyAccessExpression(callee)) {
      if (callee.questionDotToken) return undefined
      path.unshift(callee.name.text)
      callee = callee.expression
    } else if (ts.isCallExpression(callee)) {
      if (callee.questionDotToken || callee.typeArguments?.length) return undefined
      tables.unshift(...callee.arguments)
      callee = callee.expression
    } else {
      tables.unshift(callee.template)
      callee = callee.tag
    }
  }
  if (!ts.isIdentifier(callee)) return undefined
  const evidence = symbolEvidence(callee, context)
  const imported = evidence.importedNames.find((name) => TEST_NAMES.has(name))
  const framework = evidence.modules.some((module) => FRAMEWORKS.has(module))
  const root = imported && (framework || imported === 'test') ? imported
    : framework && evidence.importedNames.includes('*') ? path.shift()
      : !evidence.declaredInSource ? callee.text : undefined
  if (!root || !TEST_NAMES.has(root)) return undefined
  const scope = root === 'test' && (path[0] === 'describe' || Object.hasOwn(HOOKS, path[0])) ? path.shift()! : root
  // test.skip(fixturePredicate, reason) configures a condition; it does not
  // register a skipped test whose body is that predicate.
  if ((scope === 'test' || scope === 'it') && !ts.isStringLiteralLike(call.arguments[0]) && !ts.isTemplateExpression(call.arguments[0])) return undefined
  if (path.some((part) => part !== 'each' && !Object.hasOwn(MODIFIERS, part))) return undefined
  // Curried calls are registration tables only when .each is explicit.
  if (tables.length && !path.includes('each')) return undefined
  const prefix = HOOKS[scope] ?? (scope === 'describe' ? 'Test group' : 'Test')
  const args = call.arguments.filter((arg) => arg !== callback).map(sourceExpressionText)
  const modifiers = path.filter((part) => part !== 'each').map((part) => MODIFIERS[part])
  const details = [
    args.length ? args.join('; ') : '',
    modifiers.length ? `(${modifiers.join(', ')})` : '',
    path.includes('each') ? `for each case in ${tables.map(sourceExpressionText).join(', ')}` : '',
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'with an asynchronous callback' : '',
    callback.parameters.length ? `receiving ${callback.parameters.map(sourceParameterText).join(', ')}` : '',
    callback.type ? `returning type ${renderEnglish(typeEnglish(callback.type))}` : '',
  ].filter(Boolean)
  // Generic or generator callbacks need the full grammar to preserve their contract.
  if (callback.typeParameters?.length || (ts.isFunctionExpression(callback) && (callback.asteriskToken || callback.name))) return undefined
  return { text: `${prefix}${details.length ? `: ${details.join('; ')}` : ''}`, callback }
}
