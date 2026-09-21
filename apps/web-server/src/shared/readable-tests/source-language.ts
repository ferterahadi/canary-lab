import ts from 'typescript'
import { BINARY_OPERATOR_PHRASES, COMPOUND_ASSIGNMENT_PHRASES, MODIFIER_WORDS, expressionEnglish, statementEnglish, statementHeaderEnglish, typeEnglish } from '../controlled-english/ast-to-ir'
import { renderEnglish } from '../controlled-english/english-renderer'
import { symbolEvidence, type SemanticContext } from '../controlled-english/semantic-context'
import { ASSERTION_RULES } from '../controlled-english/structured-english'
import { parseExpectation } from './assertions'
import { recordSourceEnglish, sourceSyntaxFallback } from './source-representation'

const COMPARISON_OPERATORS = new Set([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword])
const SUPPORTED_FUNCTION_MODIFIERS = new Set([ts.SyntaxKind.AsyncKeyword, ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.DeclareKeyword])

export function sourceExpressionText(node: ts.Expression): string {
  return recordSourceEnglish(node, renderSourceExpressionText(node))
}

function renderSourceExpressionText(node: ts.Expression): string {
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return node.getText()
  if (ts.isRegularExpressionLiteral(node)) return `regular expression ${node.getText()}`
  if (ts.isBigIntLiteral(node)) return `big integer ${node.getText()}`
  if (node.kind === ts.SyntaxKind.ImportKeyword) return 'dynamic import'
  if (ts.isMetaProperty(node)) return node.keywordToken === ts.SyntaxKind.ImportKeyword ? `the module's ${node.name.text} metadata` : `the constructor's ${node.name.text}`
  if (ts.isTypeOfExpression(node)) return `the JavaScript type of ${sourceArgumentText(node.expression)}`
  if (ts.isVoidExpression(node)) return `undefined after evaluating ${sourceArgumentText(node.expression)}`
  if (ts.isDeleteExpression(node)) return `the result of deleting ${sourceArgumentText(node.expression)}`
  if (ts.isYieldExpression(node)) return node.expression ? `${node.asteriskToken ? 'yield each value from' : 'yield'} ${sourceArgumentText(node.expression)}` : 'yield without a value'
  if (ts.isClassExpression(node)) return `a class ${node.name?.text ?? '(anonymous)'}${classDetails(node)}`
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return jsxText(node)
  if (ts.isStringLiteral(node)) return JSON.stringify(node.text)
  if (ts.isNoSubstitutionTemplateLiteral(node)) return `template text ${JSON.stringify(node.text)}`
  if (ts.isTemplateExpression(node)) {
    const parts = [...(node.head.text ? [JSON.stringify(node.head.text)] : []),
      ...node.templateSpans.flatMap((span) => [sourceArgumentText(span.expression), ...(span.literal.text ? [JSON.stringify(span.literal.text)] : [])])]
    return `text formed by joining ${parts.join(', ')}`
  }
  if (ts.isIdentifier(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) return node.getText()
  if (ts.isParenthesizedExpression(node)) return `${ts.isOptionalChain(node.expression) ? 'the grouped value ' : ''}(${sourceExpressionText(node.expression)})`
  if (ts.isPropertyAccessExpression(node) && node.questionDotToken) {
    return `optional property ${node.name.text} from ${sourceArgumentText(node.expression)}`
  }
  if (ts.isPropertyAccessExpression(node)) return simpleReference(node.expression)
    ? `${sourceExpressionText(node.expression)}.${node.name.text}` : `${node.name.text} from ${sourceArgumentText(node.expression)}`
  if (ts.isElementAccessExpression(node)) {
    return `${node.questionDotToken ? 'optional item' : 'item'} at ${sourceArgumentText(node.argumentExpression)} from ${sourceArgumentText(node.expression)}`
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.length ? `a list containing ${node.elements.map((item) => ts.isSpreadElement(item)
      ? `all items from ${sourceArgumentText(item.expression)}` : ts.isOmittedExpression(item) ? 'an empty slot' : sourceArgumentText(item)).join(', ')}` : 'an empty list'
  }
  if (ts.isSpreadElement(node)) return `each item from ${sourceArgumentText(node.expression)} as a separate argument`
  if (ts.isNewExpression(node)) {
    const typeArguments = node.typeArguments?.length
      ? ` with type ${node.typeArguments.length === 1 ? 'argument' : 'arguments'} ${node.typeArguments.map((type) => renderEnglish(typeEnglish(type))).join(', ')}`
      : ''
    const arguments_ = node.arguments ?? []
    return `a new ${sourceArgumentText(node.expression)}${typeArguments}${arguments_.length ? ` with ${arguments_.map(sourceArgumentText).join(', ')}` : ''}`
  }
  if (ts.isCallExpression(node)) {
    return `the result of ${node.questionDotToken ? 'optionally calling ' : ''}${callTargetText(node.expression)}${callTypeArgumentsText(node)}${node.arguments.length ? ` with ${node.arguments.map(sourceArgumentText).join(', ')}` : '()'}${node.questionDotToken ? ', or undefined when the function is null or undefined' : ''}`
  }
  if (ts.isAwaitExpression(node)) {
    const value = sourceExpressionText(node.expression)
    return value.startsWith('the result of ') ? `the awaited result of ${value.slice('the result of '.length)}` : `the awaited value of ${value}`
  }
  const properties = ts.isObjectLiteralExpression(node) ? [...node.properties] : undefined
  if (properties) {
    if (!properties.length) return 'an empty object'
    return `an object with ${properties.map((property) => ts.isSpreadAssignment(property) ? `all properties copied from ${sourceArgumentText(property.expression)}` : ts.isPropertyAssignment(property)
      ? `${ts.isComputedPropertyName(property.name) ? `the property named by ${sourceArgumentText(property.name.expression)}` : property.name.getText()} set to ${sourceArgumentText(property.initializer)}`
      : ts.isShorthandPropertyAssignment(property) ? `shorthand property ${property.name.text}${property.objectAssignmentInitializer ? ` defaulting to ${sourceExpressionText(property.objectAssignmentInitializer)}` : ''}` : memberText(property)).join('; ')}`
  }
  if (ts.isConditionalExpression(node)) return `(${sourceExpressionText(node.whenTrue)} if ${sourceConditionText(node.condition)}; otherwise ${sourceExpressionText(node.whenFalse)})`
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const signature = sourceCallbackHeaderText(node)
    if (ts.isBlock(node.body)) return `${signature} that runs these statements when called:\n${indentText(callbackStatementText(node.body))}`
    const comparison = ts.isBinaryExpression(node.body) && COMPARISON_OPERATORS.has(node.body.operatorToken.kind)
    return `${signature} that returns ${comparison ? 'whether ' : ''}${sourceExpressionText(node.body)}`
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return `the value assigned by setting ${sourceArgumentText(node.left)} to ${sourceArgumentText(node.right)}`
    if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) return `the result of evaluating ${sourceArgumentText(node.left)}, discarding its result, then evaluating ${sourceArgumentText(node.right)}`
    const compound = COMPOUND_ASSIGNMENT_PHRASES.get(node.operatorToken.kind)
    if (compound) return `${compound} ${sourceArgumentText(node.left)} the value ${sourceArgumentText(node.right)}`
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return `${sourceArgumentText(node.left)}, falling back to ${sourceArgumentText(node.right)} only when the left value is null or undefined`
    }
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const condition = node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? 'truthy' : 'falsy'
      return `${sourceArgumentText(node.left)}, evaluating ${sourceArgumentText(node.right)} only when the left value is ${condition}; otherwise keeping the left value`
    }
    const operator = BINARY_OPERATOR_PHRASES.get(node.operatorToken.kind)
    if (operator) return `${sourceArgumentText(node.left)} ${operator} ${sourceArgumentText(node.right)}`
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return `not (${sourceExpressionText(node.operand)})`
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const value = sourceArgumentText(node.operand)
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
      return `${ts.isPrefixUnaryExpression(node) ? 'the updated value after' : 'the previous value before'} ${node.operator === ts.SyntaxKind.PlusPlusToken ? 'increasing' : 'decreasing'} ${value} by 1`
    }
    if (node.operator === ts.SyntaxKind.MinusToken) return `the negative of ${value}`
    if (node.operator === ts.SyntaxKind.PlusToken) return `${value} converted to a number`
    // Every other PrefixUnaryOperator was handled above.
    return `the bitwise complement of ${value}`
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    const operation = ts.isSatisfiesExpression(node) ? 'checked against type' : ts.isAsExpression(node) ? 'asserted as type' : 'asserted with a prefix type assertion as'
    return `${sourceArgumentText(node.expression)} ${operation} ${renderEnglish(typeEnglish(node.type))}`
  }
  if (ts.isNonNullExpression(node)) return `${sourceArgumentText(node.expression)} asserted to be non-null`
  return sourceSyntaxFallback(node, renderEnglish(expressionEnglish(node)))
}

function simpleReference(node: ts.Expression): boolean {
  return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword
    || ts.isPropertyAccessExpression(node) && !node.questionDotToken && simpleReference(node.expression)
}

function callTargetText(node: ts.Expression): string {
  return ts.isPropertyAccessExpression(node) && !node.questionDotToken && !simpleReference(node.expression)
    ? `${node.name.text} on (${sourceExpressionText(node.expression)})` : sourceArgumentText(node)
}

function callTypeArgumentsText(node: ts.CallExpression): string {
  return node.typeArguments?.length
    ? ` with type ${node.typeArguments.length === 1 ? 'argument' : 'arguments'} ${node.typeArguments.map((type) => renderEnglish(typeEnglish(type))).join(', ')}`
    : ''
}

export function sourceCallbackHeaderText(node: ts.ArrowFunction | ts.FunctionExpression): string {
  return recordSourceEnglish(node, callbackHeaderText(node))
}

function callbackHeaderText(node: ts.ArrowFunction | ts.FunctionExpression): string {
  const asynchronous = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  const parameters = node.parameters.length ? `receiving ${node.parameters.map(sourceParameterText).join(', ')}` : 'with no parameters'
  const kind = ts.isArrowFunction(node) ? 'arrow function' : `${node.asteriskToken ? 'generator ' : ''}function${node.name ? ` named ${node.name.text}` : ''}`
  return `${asynchronous || ts.isArrowFunction(node) ? 'an' : 'a'} ${asynchronous ? 'asynchronous ' : ''}${kind}${typeParametersText(node.typeParameters)} ${parameters}${node.type ? ` with return type ${renderEnglish(typeEnglish(node.type))}` : ''}`
}

export function sourceCallbackExpressionCall(expression: ts.Expression): { call: ts.CallExpression; text: string } | undefined {
  const awaited = ts.isAwaitExpression(expression)
  const call = awaited ? expression.expression : expression
  if (!ts.isCallExpression(call) || call.questionDotToken
    || !call.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) return undefined
  return { call, text: `Call ${callTargetText(call.expression)}${callTypeArgumentsText(call)}${awaited ? ' and wait for it to finish' : ''}` }
}

/** Only split a direct call whose surrounding evaluation is represented here.
 * Wrapped or optional expressions keep their complete expression rendering. */
export function sourceCallbackCall(node: ts.Statement): { call: ts.CallExpression; text: string; role: 'setup' | 'action' } | undefined {
  const binding = ts.isVariableStatement(node) && !node.modifiers?.length
    && !(node.declarationList.flags & ts.NodeFlags.Using) && node.declarationList.declarations.length === 1
    ? node.declarationList.declarations[0] : undefined
  if (binding && (!ts.isIdentifier(binding.name) || binding.exclamationToken)) return undefined
  const expression = ts.isExpressionStatement(node) || ts.isReturnStatement(node) ? node.expression : binding?.initializer
  if (!expression) return undefined
  const description = sourceCallbackExpressionCall(expression)
  if (!description) return undefined
  let { text } = description
  if (ts.isReturnStatement(node)) text += ' and return its result'
  if (binding && ts.isVariableStatement(node)) {
    const kind = node.declarationList.flags & ts.NodeFlags.Const ? 'constant'
      : node.declarationList.flags & ts.NodeFlags.Let ? 'variable' : 'function-scoped variable'
    text += ` and store its result in ${kind} ${binding.name.getText()}${binding.type ? ` of type ${renderEnglish(typeEnglish(binding.type))}` : ''}`
  }
  return { call: description.call, text, role: binding ? 'setup' : 'action' }
}

function indentText(text: string): string {
  return text.split('\n').map((line) => `  ${line}`).join('\n')
}

function callbackStatementText(node: ts.Statement): string {
  return recordSourceEnglish(node, renderCallbackStatement(node))
}

function renderCallbackStatement(node: ts.Statement): string {
  if (ts.isBlock(node)) return node.statements.length ? node.statements.map(callbackStatementText).join('\n') : 'Do nothing.'
  if (ts.isIfStatement(node)) return `If ${sourceConditionText(node.expression)}:\n${indentText(callbackStatementText(node.thenStatement))}`
    + (node.elseStatement ? `\nElse:\n${indentText(callbackStatementText(node.elseStatement))}` : '')
  if (ts.isTryStatement(node)) return `Attempt these statements:\n${indentText(callbackStatementText(node.tryBlock))}`
    + (node.catchClause ? `\n${recordSourceEnglish(node.catchClause, `If an error is thrown${node.catchClause.variableDeclaration ? `, bind it to ${bindingText(node.catchClause.variableDeclaration.name)}` : ''}`)}:\n${indentText(callbackStatementText(node.catchClause.block))}` : '')
    + (node.finallyBlock ? `\nWhether the attempt succeeds or fails:\n${indentText(callbackStatementText(node.finallyBlock))}` : '')
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) return `${sourceLoopText(node)}:\n${indentText(callbackStatementText(node.statement))}`
  if (ts.isSwitchStatement(node)) return `Choose a path based on ${sourceExpressionText(node.expression)}:\n${node.caseBlock.clauses.map((clause) => {
    const header = recordSourceEnglish(clause, ts.isCaseClause(clause) ? `When ${sourceExpressionText(clause.expression)} matches` : 'When no earlier value matches')
    return `${header}:\n${indentText(clause.statements.map(callbackStatementText).join('\n') || 'Do nothing.')}`
  }).join('\n')}`
  if (ts.isFunctionDeclaration(node)) return `${sourceFunctionText(node)}${node.body ? `; when called:\n${indentText(callbackStatementText(node.body))}` : ''}`
  if (ts.isLabeledStatement(node)) return `Label ${node.label.text}:\n${indentText(callbackStatementText(node.statement))}`
  if (ts.isWithStatement(node)) return `Use ${sourceExpressionText(node.expression)} as the active scope:\n${indentText(callbackStatementText(node.statement))}`
  return sourceAssertionText(node) ?? sourceDeclarationText(node) ?? sourceStatementText(node) ?? sourceSyntaxFallback(node, renderEnglish(statementEnglish(node)))
}

/** Explicit grouping prevents nested argument/property lists from merging. */
function sourceArgumentText(node: ts.Expression): string {
  const text = sourceExpressionText(node)
  return ts.isCallExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
    || ts.isArrowFunction(node) || ts.isAwaitExpression(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node)
    || ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node) && !simpleReference(node)
    || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)
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
  return `${modifierText(node)}${node.dotDotDotToken ? 'remaining arguments collected in ' : ''}${bindingText(node.name)}${node.questionToken ? ' (optional)' : ''}${node.type ? ` of type ${renderEnglish(typeEnglish(node.type))}` : ''}${node.initializer ? `, defaulting to ${sourceExpressionText(node.initializer)}` : ''}`
}

function modifierText(node: ts.Node): string {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []
  return decorators.map((decorator) => `decorated with ${sourceExpressionText(decorator.expression)}; `).join('')
    + modifiers.map((modifier) => `${MODIFIER_WORDS[modifier.kind]} `).join('')
}

function typeParametersText(parameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): string {
  return parameters?.length ? ` with type parameters ${parameters.map((parameter) => `${modifierText(parameter)}${parameter.name.text}${parameter.constraint ? ` extending ${renderEnglish(typeEnglish(parameter.constraint))}` : ''}${parameter.default ? ` defaulting to ${renderEnglish(typeEnglish(parameter.default))}` : ''}`).join(', ')}` : ''
}

function bindingText(node: ts.BindingName): string {
  if (ts.isIdentifier(node)) return node.text
  const elements = node.elements.map((element, index) => ts.isOmittedExpression(element) ? `skip item ${index + 1}`
    : `${element.dotDotDotToken ? 'remaining entries as ' : ts.isArrayBindingPattern(node) ? `item ${index + 1} as ` : element.propertyName ? `property ${ts.isComputedPropertyName(element.propertyName) ? `named by ${sourceExpressionText(element.propertyName.expression)}` : element.propertyName.getText()} as ` : 'property '}${bindingText(element.name)}${element.initializer ? `, defaulting to ${sourceExpressionText(element.initializer)}` : ''}`)
  return `${ts.isArrayBindingPattern(node) ? 'array pattern' : 'object pattern'} (${elements.join('; ')})`
}

export function sourceCatchText(node: ts.CatchClause): string {
  return `If the attempt fails${node.variableDeclaration ? `, save the error as ${bindingText(node.variableDeclaration.name)}` : ''}`
}

export function sourceFunctionText(node: ts.FunctionDeclaration): string {
  if (node.modifiers?.some((modifier) => !SUPPORTED_FUNCTION_MODIFIERS.has(modifier.kind))) {
    return sourceSyntaxFallback(node, renderEnglish(statementHeaderEnglish(node)))
  }
  const asynchronous = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  const exported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  const defaultExport = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  const ambient = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
  return `${ambient ? 'Declare' : 'Define'} ${exported ? 'exported ' : ''}${defaultExport ? 'default ' : ''}${asynchronous ? 'asynchronous ' : ''}${node.asteriskToken ? 'generator ' : ''}function ${node.name?.text ?? '(anonymous)'}${typeParametersText(node.typeParameters)}`
    + (node.parameters.length ? `, taking ${node.parameters.map(sourceParameterText).join('; ')}` : ' with no parameters')
    + (node.type ? `, with return type ${renderEnglish(typeEnglish(node.type))}` : '')
    + (node.body ? '' : ', with no body')
}

export function sourceFunctionBinding(node: ts.Statement): {
  callback: ts.ArrowFunction | ts.FunctionExpression
  text: string
} | undefined {
  if (!ts.isVariableStatement(node) || node.modifiers?.some((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword)
    || node.declarationList.flags & ts.NodeFlags.Using
    || node.declarationList.declarations.length !== 1) return undefined
  const binding = node.declarationList.declarations[0]
  if (!ts.isIdentifier(binding.name) || binding.exclamationToken || !binding.initializer
    || (!ts.isArrowFunction(binding.initializer) && !ts.isFunctionExpression(binding.initializer))) return undefined
  const callback = binding.initializer
  const conciseArrow = ts.isArrowFunction(callback)
  const parameters = callback.parameters.length
    ? `, taking ${callback.parameters.map(sourceParameterText).join('; ')}`
    : ' with no parameters'
  const callbackType = callback.type ? `, with return type ${renderEnglish(typeEnglish(callback.type))}` : ''
  const definition = conciseArrow
    ? `Define ${modifierText(node)}${callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'asynchronous ' : ''}arrow function ${binding.name.text}${typeParametersText(callback.typeParameters)}${parameters}${callbackType}${binding.type ? `, with variable type ${renderEnglish(typeEnglish(binding.type))}` : ''}`
    : `Define ${modifierText(node)}${binding.name.text} as ${sourceCallbackHeaderText(callback)}${binding.type ? `, with variable type ${renderEnglish(typeEnglish(binding.type))}` : ''}`
  const kind = node.declarationList.flags & ts.NodeFlags.Const ? 'a constant' : node.declarationList.flags & ts.NodeFlags.Let ? 'a variable' : 'a function-scoped variable'
  const text = `${definition}, stored as ${kind}`
  recordSourceEnglish(callback, text)
  return {
    callback,
    text,
  }
}

export function sourceConditionText(node: ts.Expression): string {
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return `${sourceExpressionText(node.operand)} is falsy`
  if (ts.isBinaryExpression(node) && COMPARISON_OPERATORS.has(node.operatorToken.kind)) return sourceExpressionText(node)
  return `${sourceExpressionText(node)} is truthy`
}

export function sourceLoopText(node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement | ts.WhileStatement | ts.DoStatement): string {
  if (ts.isWhileStatement(node)) return `While ${sourceConditionText(node.expression)}; this may run zero times`
  if (ts.isDoStatement(node)) return `Run once, then repeat while ${sourceConditionText(node.expression)}`
  if (ts.isForStatement(node)) {
    const initializerNode = node.initializer
    const initializer = initializerNode && ts.isVariableDeclarationList(initializerNode)
      ? declarationListText(initializerNode)
      : initializerNode && !ts.isVariableDeclarationList(initializerNode) ? sourceExpressionText(initializerNode) : undefined
    const update = node.incrementor && (ts.isBinaryExpression(node.incrementor)
      && node.incrementor.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? `set ${sourceExpressionText(node.incrementor.left)} to ${sourceExpressionText(node.incrementor.right)}`
      : sourceExpressionText(node.incrementor))
    return [
      node.condition ? `Repeat while ${sourceConditionText(node.condition)}` : 'Repeat until stopped',
      initializer ? `starting with ${initializer}` : undefined,
      update ? `after each pass, ${update}` : undefined,
    ].filter((part): part is string => Boolean(part)).join('; ')
  }
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
  const binding = ts.isVariableDeclarationList(node.initializer) ? declarationListText(node.initializer) : sourceExpressionText(node.initializer)
  return `For each ${ts.isForInStatement(node) ? 'enumerable property key' : 'value'} in ${sourceExpressionText(node.expression)}, bind ${binding}${ts.isForOfStatement(node) && node.awaitModifier ? ', awaiting each value' : ''}`
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
  if (ts.isBreakStatement(node)) return node.label ? `Leave the block labelled ${node.label.text}` : 'Leave this loop or switch'
  if (ts.isContinueStatement(node)) return `Continue with the next iteration${node.label ? ` of ${node.label.text}` : ''}`
  if (ts.isEmptyStatement(node)) return 'Do nothing'
  if (ts.isDebuggerStatement(node)) return 'Pause here if a debugger is attached'
  if (ts.isExportAssignment(node)) return `${node.isExportEquals ? 'Assign the module export to' : 'Export as the default value'} ${sourceExpressionText(node.expression)}`
  if (ts.isReturnStatement(node)) return node.expression ? `Return ${sourceExpressionText(node.expression)}` : 'Return without a value'
  if (ts.isThrowStatement(node)) return `Throw ${sourceExpressionText(node.expression)}`
  if (!ts.isExpressionStatement(node)) return undefined
  const expression = node.expression
  if (ts.isConditionalExpression(expression)) return undefined
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return `Set ${sourceExpressionText(expression.left)} to ${sourceExpressionText(expression.right)}`
  }
  if (ts.isCallExpression(expression) || ts.isAwaitExpression(expression)) {
    const call = ts.isAwaitExpression(expression) ? expression.expression : expression
    if (!ts.isCallExpression(call) || call.questionDotToken) return ts.isAwaitExpression(expression)
      ? `Wait for ${sourceExpressionText(call)}` : sourceExpressionText(expression)
    const target = `${callTargetText(call.expression)}${callTypeArgumentsText(call)}`
    const wait = ts.isAwaitExpression(expression) ? ' and wait for it to finish' : ''
    if (call.arguments.some(ts.isArrowFunction)) {
      return `Call ${target}${wait}. Pass these arguments in order:\n`
        + call.arguments.map((argument, index) => `${index + 1}. ${sourceExpressionText(argument)}`).join('\n')
    }
    return `Call ${target}${call.arguments.length ? ` with ${call.arguments.map(sourceArgumentText).join(', ')}` : ' with no arguments'}${wait}`
  }
  return recordSourceEnglish(node, `Evaluate ${sourceExpressionText(expression)}`)
}

export function sourceAssertionText(node: ts.Statement): string | undefined {
  if (!ts.isExpressionStatement(node)) return undefined
  const awaited = ts.isAwaitExpression(node.expression)
  const expression = awaited ? node.expression.expression : node.expression
  if (!ts.isCallExpression(expression) || expression.typeArguments?.length || expression.questionDotToken) return undefined
  const expectation = parseExpectation(expression, { allowPoll: true })
  if (!expectation) return undefined
  const receiver = expectation.actual.parent as ts.CallExpression
  // The concise form must not erase optional invocation, generics or extra
  // arguments on the expect receiver. Those keep the exhaustive grammar.
  if (receiver.questionDotToken || receiver.typeArguments?.length || receiver.arguments.length > 2
    || ts.isPropertyAccessExpression(receiver.expression) && receiver.expression.questionDotToken) return undefined
  if (expectation.poll && expectation.settlement) return undefined
  const propertyCheck = expectation.matcher === 'toHaveProperty'
  if (propertyCheck && (expression.arguments.length < 1 || expression.arguments.length > 2)) return undefined
  const rule = propertyCheck
    ? { expectedArguments: 1, relation: 'has property', negatedRelation: 'does not have property' }
    : ASSERTION_RULES.find((rule) => rule.matcher === expectation.matcher)
  if (!rule || expression.arguments.length < rule.expectedArguments) return undefined
  const subject = sourceExpressionText(expectation.actual)
  const settled = expectation.settlement === 'resolves' ? `the resolved value of ${subject}`
    : expectation.settlement === 'rejects' ? `the rejection from ${subject}` : subject
  const expected = rule.expectedArguments ? ` ${sourceArgumentText(expression.arguments[0])}` : ''
  // The second property argument is an expected value, not matcher options.
  const propertyValue = propertyCheck && expression.arguments[1]
  const extra = expression.arguments.slice(propertyCheck ? 2 : rule.expectedArguments)
  if (expectation.poll) {
    return `Poll until the returned value ${expectation.negated ? rule.negatedRelation : rule.relation}${expected}`
      + (propertyValue ? ` equal to ${sourceArgumentText(propertyValue)}` : '')
      + (extra.length ? `; with matcher arguments ${extra.map(sourceArgumentText).join(', ')}` : '')
      + (awaited ? '; wait for the check to finish' : '; without awaiting the check')
      + `\nOn each attempt: ${pollCallbackText(expectation.actual)}`
      + (expectation.pollOptions ? `\n${pollOptionsText(expectation.pollOptions)}` : '')
  }
  return `${awaited ? 'Wait for the check' : 'Check'} that ${settled} ${expectation.negated ? rule.negatedRelation : rule.relation}${expected}`
    + (propertyValue ? ` equal to ${sourceArgumentText(propertyValue)}` : '')
    + (expectation.soft ? '; continue collecting failures if this check fails' : '')
    + (expectation.message ? `; with failure message ${sourceExpressionText(expectation.message)}` : '')
    + (extra.length ? `; with additional arguments ${extra.map(sourceArgumentText).join(', ')}` : '')
}

function pollCallbackText(callback: ts.Expression): string {
  if (ts.isArrowFunction(callback) && !callback.parameters.length && !callback.typeParameters?.length
    && !callback.type && !ts.isBlock(callback.body)) {
    const asynchronous = callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    return recordSourceEnglish(callback, `read ${sourceExpressionText(callback.body)}${asynchronous ? ', using an asynchronous callback' : ''}`)
  }
  return `call ${sourceArgumentText(callback)}`
}

function pollOptionsText(options: ts.Expression): string {
  if (ts.isStringLiteralLike(options)) return `Failure message: ${sourceExpressionText(options)}`
  const assignments = ts.isObjectLiteralExpression(options) ? [...options.properties] : undefined
  if (!assignments || !assignments.every(ts.isPropertyAssignment)) {
    return `Polling options: ${sourceExpressionText(options)}`
  }
  const properties = assignments.map((property) => {
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined
    const value = sourceExpressionText(property.initializer)
    if (name === 'timeout' || name === 'interval') return `${name === 'timeout' ? 'timeout' : 'retry interval'} set to ${value} milliseconds`
    if (name === 'intervals') return `retry intervals in milliseconds set to ${value}`
    if (name === 'message') return `failure message set to ${value}`
    return `${property.name.getText()} set to ${value}`
  })
  return `Polling options: ${properties.join('; ') || 'an empty object'}`
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

function declarationListText(list: ts.VariableDeclarationList): string {
  const kind = (list.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing ? 'asynchronously disposed resource'
    : list.flags & ts.NodeFlags.Using ? 'automatically disposed resource'
      : list.flags & ts.NodeFlags.Const ? 'constant' : list.flags & ts.NodeFlags.Let ? 'variable' : 'function-scoped variable'
  return list.declarations.map((binding) => `${kind} ${bindingText(binding.name)}${binding.exclamationToken ? ', asserted to be definitely assigned' : ''}${binding.type ? ` of type ${renderEnglish(typeEnglish(binding.type))}` : ''}${binding.initializer ? ` set to ${sourceExpressionText(binding.initializer)}` : ' without an initial value'}`).join('; ')
}

function memberText(node: ts.ClassElement | ts.TypeElement | ts.ObjectLiteralElementLike): string {
  return recordSourceEnglish(node, renderMemberText(node))
}

function renderMemberText(node: ts.ClassElement | ts.TypeElement | ts.ObjectLiteralElementLike): string {
  const name = node.name ? ts.isComputedPropertyName(node.name) ? `the name computed from ${sourceExpressionText(node.name.expression)}` : node.name.getText() : ''
  const modifiers = modifierText(node)
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return `${modifiers}property ${name}${node.questionToken ? ' (optional)' : ''}${ts.isPropertyDeclaration(node) && node.exclamationToken ? ' (definitely assigned)' : ''}${node.type ? ` of type ${renderEnglish(typeEnglish(node.type))}` : ''}${ts.isPropertyDeclaration(node) && node.initializer ? ` initialized to ${sourceExpressionText(node.initializer)}` : ''}`
  if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isMethodSignature(node) || ts.isCallSignatureDeclaration(node) || ts.isConstructSignatureDeclaration(node) || ts.isIndexSignatureDeclaration(node)) {
    const kind = ts.isConstructorDeclaration(node) || ts.isConstructSignatureDeclaration(node) ? 'constructor' : ts.isGetAccessorDeclaration(node) ? 'getter' : ts.isSetAccessorDeclaration(node) ? 'setter' : ts.isIndexSignatureDeclaration(node) ? 'index signature' : ts.isCallSignatureDeclaration(node) ? 'call signature' : 'method'
    const header = `${modifiers}${ts.isMethodDeclaration(node) && node.asteriskToken ? 'generator ' : ''}${kind}${name ? ` ${name}` : ''}${'questionToken' in node && node.questionToken ? ' (optional)' : ''}${typeParametersText(node.typeParameters)}${node.parameters.length ? ` taking ${node.parameters.map(sourceParameterText).join('; ')}` : ' with no parameters'}${node.type ? ` returning type ${renderEnglish(typeEnglish(node.type))}` : ''}`
    return `${header}${'body' in node && node.body ? `; when invoked:\n${indentText(callbackStatementText(node.body))}` : ', with no body'}`
  }
  if (ts.isClassStaticBlockDeclaration(node)) return `static initialization:\n${indentText(callbackStatementText(node.body))}`
  if (ts.isSemicolonClassElement(node)) return 'an empty class member'
  return sourceSyntaxFallback(node, `Untranslated member ${node.getText()}`)
}

function classDetails(node: ts.ClassDeclaration | ts.ClassExpression | ts.InterfaceDeclaration): string {
  const heritage = node.heritageClauses?.map((clause) => `${clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extending' : 'implementing'} ${clause.types.map((type) => `${sourceExpressionText(type.expression)}${type.typeArguments?.length ? ` with types ${type.typeArguments.map((arg) => renderEnglish(typeEnglish(arg))).join(', ')}` : ''}`).join(', ')}`).join('; ')
  return `${typeParametersText(node.typeParameters)}${heritage ? `, ${heritage}` : ''}${node.members.length ? `, with these members:\n${indentText(node.members.map(memberText).join('\n'))}` : ', with no members'}`
}

function jsxText(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment): string {
  const opening = ts.isJsxFragment(node) ? undefined : ts.isJsxElement(node) ? node.openingElement : node
  const properties = opening?.attributes.properties.map((property) => ts.isJsxSpreadAttribute(property)
    ? `all attributes from ${sourceExpressionText(property.expression)}`
    : `${property.name.getText()} set to ${!property.initializer ? 'true' : ts.isStringLiteral(property.initializer) ? JSON.stringify(property.initializer.text) : ts.isJsxExpression(property.initializer) ? property.initializer.expression ? sourceExpressionText(property.initializer.expression) : 'an empty expression' : jsxText(property.initializer)}`)
  const children = ts.isJsxSelfClosingElement(node) ? [] : node.children.map((child) => ts.isJsxText(child) ? `text ${JSON.stringify(child.text)}`
    : ts.isJsxExpression(child) ? child.expression ? `the value of ${sourceExpressionText(child.expression)}` : 'an empty expression' : jsxText(child))
  return `a JSX ${opening ? `element named ${opening.tagName.getText()}` : 'fragment'}${properties?.length ? ` with attributes ${properties.join('; ')}` : ''}${children.length ? ` containing, in order: ${children.join('; ')}` : ' with no children'}`
}

/** Syntax stays literal: names and types are preserved, never domain-inferred. */
export function sourceDeclarationText(node: ts.Statement): string | undefined {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) return `Define ${modifierText(node)}${ts.isClassDeclaration(node) ? 'class' : 'interface'} ${node.name?.text ?? '(anonymous)'}${classDetails(node)}`
  if (ts.isTypeAliasDeclaration(node)) return `Define ${modifierText(node)}type ${node.name.text}${typeParametersText(node.typeParameters)} as ${renderEnglish(typeEnglish(node.type))}`
  if (ts.isEnumDeclaration(node)) return `Define ${modifierText(node)}enum ${node.name.text} with members ${node.members.map((member) => `${member.name.getText()}${member.initializer ? ` set to ${sourceExpressionText(member.initializer)}` : ' with an automatically assigned value'}`).join('; ')}`
  if (ts.isExportDeclaration(node)) {
    const bindings = !node.exportClause ? 'all exports' : ts.isNamespaceExport(node.exportClause) ? `all exports as ${node.exportClause.name.getText()}`
      : node.exportClause.elements.map((element) => `${element.isTypeOnly ? 'type ' : ''}${element.propertyName ? `${element.propertyName.getText()} as ` : ''}${element.name.getText()}`).join(', ')
    return `Export ${node.isTypeOnly ? 'types ' : ''}${bindings}${node.moduleSpecifier ? ` from ${sourceExpressionText(node.moduleSpecifier)}` : ''}${node.attributes ? ` with attributes ${node.attributes.elements.map((element) => `${element.name.getText()} set to ${sourceExpressionText(element.value)}`).join(', ')}` : ''}`
  }
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
    if (node.modifiers?.length || node.declarationList.flags & ts.NodeFlags.Using
      || node.declarationList.declarations.some((binding) => !ts.isIdentifier(binding.name) || binding.exclamationToken)) {
      return `Declare ${modifierText(node)}${declarationListText(node.declarationList)}`
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
  role: 'test' | 'setup'
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
  const isTest = scope === 'test' || scope === 'it'
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
  const text = `${prefix}${details.length ? `: ${details.join('; ')}` : ''}`
  recordSourceEnglish(callback, text)
  return { role: isTest ? 'test' : 'setup', text, callback }
}
