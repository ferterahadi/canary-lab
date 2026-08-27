import ts from 'typescript'
import { atom, clause, seq, isVerbNode, type EnglishClause, type EnglishNode, type EnglishSegment } from './ir'
import { isInline, renderInline } from './english-renderer'
import { canonicalKindName } from './syntax-kinds'

// AST → English IR. Every function here maps one grammar production to its
// single canonical English form (documented in vocabulary.ts and
// docs/controlled-english/). No wording decision may live anywhere else, and
// no construct may fall back to generic prose: an unmapped kind throws.

export class UnsupportedSyntaxKindError extends Error {
  readonly kindName: string
  constructor(kindName: string) {
    super(`UNSUPPORTED_SYNTAX_KIND: ${kindName}`)
    this.name = 'UnsupportedSyntaxKindError'
    this.kindName = kindName
  }
}

function unsupported(kind: ts.SyntaxKind): never {
  throw new UnsupportedSyntaxKindError(canonicalKindName(kind))
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function nameAtom(text: string): EnglishNode {
  return atom('name', `\`${text}\``)
}

function entityNameText(name: ts.EntityName): string {
  return ts.isQualifiedName(name) ? `${entityNameText(name.left)}.${name.right.text}` : name.text
}

/** Value slot: a verb (call, await, assignment, …) always takes its own
 *  indented block under the label so nesting stays visible. */
function slot(label: string, child: EnglishNode): EnglishSegment {
  return isVerbNode(child) ? { label, child, separate: true } : { label, child }
}

/** Parenthesized grouping: tight `(…)` text when the content is inline,
 *  a labelled block otherwise. */
function grouped(inner: EnglishNode): EnglishNode {
  if (isInline(inner)) return atom('group', `(${renderInline(inner)})`)
  return clause('group', [{ label: 'group of', child: inner }])
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export const BINARY_OPERATOR_PHRASES: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.PlusToken, 'plus'],
  [ts.SyntaxKind.MinusToken, 'minus'],
  [ts.SyntaxKind.AsteriskToken, 'multiplied by'],
  [ts.SyntaxKind.SlashToken, 'divided by'],
  [ts.SyntaxKind.PercentToken, 'remainder'],
  [ts.SyntaxKind.AsteriskAsteriskToken, 'raised to the power of'],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, 'is strictly equal to'],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, 'is strictly unequal to'],
  [ts.SyntaxKind.EqualsEqualsToken, 'is loosely equal to'],
  [ts.SyntaxKind.ExclamationEqualsToken, 'is loosely unequal to'],
  [ts.SyntaxKind.GreaterThanToken, 'is greater than'],
  [ts.SyntaxKind.GreaterThanEqualsToken, 'is greater than or equal to'],
  [ts.SyntaxKind.LessThanToken, 'is less than'],
  [ts.SyntaxKind.LessThanEqualsToken, 'is less than or equal to'],
  [ts.SyntaxKind.AmpersandAmpersandToken, 'and'],
  [ts.SyntaxKind.BarBarToken, 'or'],
  [ts.SyntaxKind.QuestionQuestionToken, 'or-if-nullish'],
  [ts.SyntaxKind.InKeyword, 'is a key in'],
  [ts.SyntaxKind.InstanceOfKeyword, 'is an instance of'],
  [ts.SyntaxKind.AmpersandToken, 'bitwise-AND'],
  [ts.SyntaxKind.BarToken, 'bitwise-OR'],
  [ts.SyntaxKind.CaretToken, 'bitwise-XOR'],
  [ts.SyntaxKind.LessThanLessThanToken, 'shifted left by'],
  [ts.SyntaxKind.GreaterThanGreaterThanToken, 'shifted right (sign-preserving) by'],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, 'shifted right (zero-filling) by'],
])

export const COMPOUND_ASSIGNMENT_PHRASES: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.PlusEqualsToken, 'add and assign to'],
  [ts.SyntaxKind.MinusEqualsToken, 'subtract and assign to'],
  [ts.SyntaxKind.AsteriskEqualsToken, 'multiply and assign to'],
  [ts.SyntaxKind.SlashEqualsToken, 'divide and assign to'],
  [ts.SyntaxKind.PercentEqualsToken, 'take the remainder and assign to'],
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken, 'raise to the power and assign to'],
  [ts.SyntaxKind.LessThanLessThanEqualsToken, 'shift left and assign to'],
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, 'shift right (sign-preserving) and assign to'],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, 'shift right (zero-filling) and assign to'],
  [ts.SyntaxKind.AmpersandEqualsToken, 'bitwise-AND and assign to'],
  [ts.SyntaxKind.BarEqualsToken, 'bitwise-OR and assign to'],
  [ts.SyntaxKind.CaretEqualsToken, 'bitwise-XOR and assign to'],
  [ts.SyntaxKind.AmpersandAmpersandEqualsToken, 'assign if truthy to'],
  [ts.SyntaxKind.BarBarEqualsToken, 'assign if falsy to'],
  [ts.SyntaxKind.QuestionQuestionEqualsToken, 'assign if nullish to'],
])

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** Operands that are themselves binary expressions get explicit grouping, so
 *  `a + b * c` and `(a + b) * c` can never read the same. (A conditional can
 *  only be an operand through source parentheses — precedence — so the
 *  ParenthesizedExpression case already covers it.) */
function operandEnglish(node: ts.Expression): EnglishNode {
  const english = expressionEnglish(node)
  if (ts.isBinaryExpression(node)) return grouped(english)
  return english
}

function binaryEnglish(node: ts.BinaryExpression): EnglishNode {
  const operator = node.operatorToken.kind
  if (operator === ts.SyntaxKind.EqualsToken) {
    return clause('assign', [
      { label: 'assign', child: expressionEnglish(node.left) },
      slot('the value', expressionEnglish(node.right)),
    ])
  }
  const compound = COMPOUND_ASSIGNMENT_PHRASES.get(operator)
  if (compound) {
    return clause('assign', [
      { label: compound, child: expressionEnglish(node.left) },
      slot('the value', expressionEnglish(node.right)),
    ])
  }
  if (operator === ts.SyntaxKind.CommaToken) {
    return clause('comma-sequence', [
      slot('evaluate and discard', expressionEnglish(node.left)),
      slot('then yield', expressionEnglish(node.right)),
    ])
  }
  const phrase = BINARY_OPERATOR_PHRASES.get(operator)
  if (!phrase) unsupported(operator)
  return seq('binary', [operandEnglish(node.left), atom('operator', phrase), operandEnglish(node.right)])
}

function prefixUnaryEnglish(node: ts.PrefixUnaryExpression): EnglishNode {
  const operand = expressionEnglish(node.operand)
  switch (node.operator) {
    case ts.SyntaxKind.ExclamationToken:
      return seq('not', [atom('operator', 'not'), operand])
    case ts.SyntaxKind.MinusToken:
      return seq('negate', [atom('operator', 'negative'), operand])
    case ts.SyntaxKind.PlusToken:
      return seq('unary-plus', [atom('operator', 'positive'), operand])
    case ts.SyntaxKind.TildeToken:
      return seq('bitwise-not', [atom('operator', 'bitwise-NOT'), operand])
    case ts.SyntaxKind.PlusPlusToken:
      return clause('increment', [{ label: 'increment', child: operand }, { label: 'and yield the new value' }])
    case ts.SyntaxKind.MinusMinusToken:
      return clause('decrement', [{ label: 'decrement', child: operand }, { label: 'and yield the new value' }])
  }
}

function postfixUnaryEnglish(node: ts.PostfixUnaryExpression): EnglishNode {
  const operand = expressionEnglish(node.operand)
  return node.operator === ts.SyntaxKind.PlusPlusToken
    ? clause('increment', [{ label: 'increment', child: operand }, { label: 'and yield the previous value' }])
    : clause('decrement', [{ label: 'decrement', child: operand }, { label: 'and yield the previous value' }])
}

function typeArgumentsSegment(typeArguments: ts.NodeArray<ts.TypeNode> | undefined): EnglishSegment[] {
  if (!typeArguments || typeArguments.length === 0) return []
  const label = typeArguments.length === 1 ? 'with type argument' : 'with type arguments'
  return [{ label, list: typeArguments.map(typeEnglish) }]
}

/** Call/construct arguments. A lone plain name or literal shares the label
 *  line; any structured argument takes its own indented line. */
function argumentSegments(args: ts.NodeArray<ts.Expression> | undefined): EnglishSegment[] {
  if (!args) return []
  if (args.length === 0) return [{ label: 'with no arguments' }]
  if (args.length === 1) {
    const english = expressionEnglish(args[0])
    return english.kind === 'atom'
      ? [{ label: 'with argument', child: english }]
      : [{ label: 'with argument', child: english, separate: true }]
  }
  return [{ label: 'with arguments', list: args.map(expressionEnglish) }]
}

function callEnglish(node: ts.CallExpression): EnglishNode {
  const verb = node.questionDotToken ? 'optionally call' : 'call'
  return clause(
    'call',
    [
      { label: verb, child: expressionEnglish(node.expression) },
      ...typeArgumentsSegment(node.typeArguments),
      ...argumentSegments(node.arguments),
    ],
    node.arguments.length > 0 ? 'block' : undefined,
  )
}

function newEnglish(node: ts.NewExpression): EnglishNode {
  return clause(
    'construct',
    [
      { label: 'construct a new', child: expressionEnglish(node.expression) },
      ...typeArgumentsSegment(node.typeArguments),
      ...argumentSegments(node.arguments),
    ],
    node.arguments && node.arguments.length > 0 ? 'block' : undefined,
  )
}

function propertyAccessEnglish(node: ts.PropertyAccessExpression): EnglishNode {
  const label = node.questionDotToken ? 'optional property' : 'property'
  return clause('property-access', [
    { label, child: nameAtom(node.name.text) },
    { label: 'of', child: expressionEnglish(node.expression) },
  ])
}

function elementAccessEnglish(node: ts.ElementAccessExpression): EnglishNode {
  const label = node.questionDotToken ? 'optional element' : 'element'
  return clause('element-access', [
    { label, child: expressionEnglish(node.argumentExpression) },
    { label: 'of', child: expressionEnglish(node.expression) },
  ])
}

function templateEnglish(node: ts.TemplateExpression): EnglishNode {
  const items: EnglishNode[] = []
  if (node.head.text !== '') items.push(atom('template-text', `text ${JSON.stringify(node.head.text)}`))
  for (const span of node.templateSpans) {
    items.push(seq('template-value', [atom('label', 'value of'), expressionEnglish(span.expression)]))
    if (span.literal.text !== '') items.push(atom('template-text', `text ${JSON.stringify(span.literal.text)}`))
  }
  return clause('template-string', [{ label: 'template string joining', list: items }])
}

function objectPropertyName(name: ts.PropertyName): EnglishNode {
  if (ts.isComputedPropertyName(name)) {
    return clause('computed-name', [{ label: 'named by', child: expressionEnglish(name.expression) }])
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return nameAtom(name.text)
  return expressionEnglish(name)
}

function objectLiteralEnglish(node: ts.ObjectLiteralExpression): EnglishNode {
  if (node.properties.length === 0) return clause('object-literal', [{ label: 'an empty object literal' }])
  return clause('object-literal', [
    { label: 'an object literal with', list: node.properties.map(objectMemberEnglish) },
  ])
}

function objectMemberEnglish(member: ts.ObjectLiteralElementLike): EnglishNode {
  switch (member.kind) {
    case ts.SyntaxKind.PropertyAssignment:
      return clause('object-property', [
        { label: 'property', child: objectPropertyName(member.name) },
        slot('set to', expressionEnglish(member.initializer)),
      ])
    case ts.SyntaxKind.ShorthandPropertyAssignment: {
      const segments: EnglishSegment[] = [{ label: 'shorthand property', child: nameAtom(member.name.text) }]
      if (member.objectAssignmentInitializer) {
        segments.push(slot('with default', expressionEnglish(member.objectAssignmentInitializer)))
      }
      return clause('object-property', segments)
    }
    case ts.SyntaxKind.SpreadAssignment:
      return seq('spread', [atom('label', 'spread of'), expressionEnglish(member.expression)])
    case ts.SyntaxKind.MethodDeclaration:
      return methodEnglish(member)
    case ts.SyntaxKind.GetAccessor:
      return accessorEnglish(member)
    case ts.SyntaxKind.SetAccessor:
      return accessorEnglish(member)
    default:
      // The public type is exhaustive, but factory-created or future compiler
      // nodes can still reach this runtime boundary. Keep the explicit error
      // contract without widening the normal caller type.
      unsupported((member as ts.Node).kind)
  }
}

function arrayLiteralEnglish(node: ts.ArrayLiteralExpression): EnglishNode {
  if (node.elements.length === 0) return clause('array-literal', [{ label: 'an empty array literal' }])
  return clause('array-literal', [{ label: 'an array literal of', list: node.elements.map(expressionEnglish) }])
}

function arrowFunctionEnglish(node: ts.ArrowFunction): EnglishNode {
  const isAsync = ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false
  const segments: EnglishSegment[] = [{ label: isAsync ? 'asynchronous arrow function' : 'arrow function' }]
  segments.push(...typeParametersSegment(node.typeParameters))
  if (node.parameters.length === 0) segments.push({ label: 'with no parameters' })
  else for (const parameter of node.parameters) segments.push({ label: '', child: parameterEnglish(parameter) })
  if (node.type) segments.push({ label: 'return type', child: typeEnglish(node.type), separate: true })
  if (ts.isBlock(node.body)) {
    segments.push({ label: 'body', child: statementsEnglish(node.body.statements), separate: true })
  } else {
    segments.push(slot('returning', expressionEnglish(node.body)))
  }
  return clause('arrow-function', segments, 'block')
}

function functionExpressionEnglish(node: ts.FunctionExpression): EnglishNode {
  const words = modifierWords(ts.getModifiers(node))
  const head = joinWords([...words, node.asteriskToken ? 'generator' : '', 'function expression'])
  const segments: EnglishSegment[] = [
    node.name ? { label: head, child: nameAtom(node.name.text) } : { label: head },
    ...typeParametersSegment(node.typeParameters),
    parametersSegment(node.parameters),
    ...returnTypeSegment(node.type),
    { label: 'body', child: statementsEnglish(node.body.statements), separate: true },
  ]
  return clause('function-expression', segments, 'block')
}

/** Conditions read as predicates: comparison, logical, and negation forms
 *  stand alone; anything else is spelled as an explicit truthiness test. */
function conditionEnglish(node: ts.Expression): EnglishNode {
  if (ts.isBinaryExpression(node) && BINARY_OPERATOR_PHRASES.has(node.operatorToken.kind)) {
    return expressionEnglish(node)
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return expressionEnglish(node)
  }
  const english = expressionEnglish(node)
  if (isInline(english)) return seq('condition', [english, atom('truthy', 'is truthy')])
  return clause('truthy-check', [{ label: '', child: english }, { label: 'is truthy' }])
}

function conditionalEnglish(node: ts.ConditionalExpression): EnglishNode {
  return clause('conditional', [
    { label: 'if', child: conditionEnglish(node.condition) },
    slot('then yield', expressionEnglish(node.whenTrue)),
    slot('otherwise yield', expressionEnglish(node.whenFalse)),
  ])
}

export function expressionEnglish(node: ts.Expression): EnglishNode {
  switch (node.kind) {
    case ts.SyntaxKind.Identifier:
      return nameAtom((node as ts.Identifier).text)
    case ts.SyntaxKind.PrivateIdentifier:
      return nameAtom((node as ts.PrivateIdentifier).text)
    case ts.SyntaxKind.ThisKeyword:
      return atom('this', '`this`')
    case ts.SyntaxKind.SuperKeyword:
      return atom('super', '`super`')
    case ts.SyntaxKind.ImportKeyword:
      return atom('import', '`import`')
    case ts.SyntaxKind.TrueKeyword:
      return atom('boolean', 'true')
    case ts.SyntaxKind.FalseKeyword:
      return atom('boolean', 'false')
    case ts.SyntaxKind.NullKeyword:
      return atom('null', 'null')
    case ts.SyntaxKind.StringLiteral:
      return atom('string', `string ${JSON.stringify((node as ts.StringLiteral).text)}`)
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return atom('template-string', `template string ${JSON.stringify((node as ts.NoSubstitutionTemplateLiteral).text)}`)
    case ts.SyntaxKind.NumericLiteral:
      return atom('number', `number ${node.getText()}`)
    case ts.SyntaxKind.BigIntLiteral:
      return atom('bigint', `bigint ${(node as ts.BigIntLiteral).text}`)
    case ts.SyntaxKind.RegularExpressionLiteral:
      return atom('regexp', `regular expression ${(node as ts.RegularExpressionLiteral).text}`)
    case ts.SyntaxKind.PropertyAccessExpression:
      return propertyAccessEnglish(node as ts.PropertyAccessExpression)
    case ts.SyntaxKind.ElementAccessExpression:
      return elementAccessEnglish(node as ts.ElementAccessExpression)
    case ts.SyntaxKind.CallExpression:
      return callEnglish(node as ts.CallExpression)
    case ts.SyntaxKind.NewExpression:
      return newEnglish(node as ts.NewExpression)
    case ts.SyntaxKind.BinaryExpression:
      return binaryEnglish(node as ts.BinaryExpression)
    case ts.SyntaxKind.PrefixUnaryExpression:
      return prefixUnaryEnglish(node as ts.PrefixUnaryExpression)
    case ts.SyntaxKind.PostfixUnaryExpression:
      return postfixUnaryEnglish(node as ts.PostfixUnaryExpression)
    case ts.SyntaxKind.ParenthesizedExpression:
      return grouped(expressionEnglish((node as ts.ParenthesizedExpression).expression))
    case ts.SyntaxKind.ConditionalExpression:
      return conditionalEnglish(node as ts.ConditionalExpression)
    case ts.SyntaxKind.AwaitExpression:
      return clause('await', [slot('await', expressionEnglish((node as ts.AwaitExpression).expression))])
    case ts.SyntaxKind.YieldExpression: {
      const yieldNode = node as ts.YieldExpression
      if (!yieldNode.expression) return clause('yield', [{ label: 'yield' }])
      const verb = yieldNode.asteriskToken ? 'yield each value of' : 'yield'
      const tag = yieldNode.asteriskToken ? 'yield-each' : 'yield'
      return clause(tag, [slot(verb, expressionEnglish(yieldNode.expression))])
    }
    case ts.SyntaxKind.TypeOfExpression:
      return seq('typeof', [atom('operator', 'the type name of'), expressionEnglish((node as ts.TypeOfExpression).expression)])
    case ts.SyntaxKind.VoidExpression:
      return clause('void-of', [
        slot('evaluate', expressionEnglish((node as ts.VoidExpression).expression)),
        { label: 'and yield undefined' },
      ])
    case ts.SyntaxKind.DeleteExpression:
      return clause('delete', [slot('delete', expressionEnglish((node as ts.DeleteExpression).expression))])
    case ts.SyntaxKind.SpreadElement:
      return seq('spread', [atom('label', 'spread of'), expressionEnglish((node as ts.SpreadElement).expression)])
    case ts.SyntaxKind.TemplateExpression:
      return templateEnglish(node as ts.TemplateExpression)
    case ts.SyntaxKind.TaggedTemplateExpression: {
      const tagged = node as ts.TaggedTemplateExpression
      return clause('tagged-template', [
        { label: 'call tag', child: expressionEnglish(tagged.tag) },
        ...typeArgumentsSegment(tagged.typeArguments),
        // "using", not "with template": the template child names itself
        // ("template string …"), so a "template" label would stutter.
        slot('using', expressionEnglish(tagged.template)),
      ])
    }
    case ts.SyntaxKind.ObjectLiteralExpression:
      return objectLiteralEnglish(node as ts.ObjectLiteralExpression)
    case ts.SyntaxKind.ArrayLiteralExpression:
      return arrayLiteralEnglish(node as ts.ArrayLiteralExpression)
    case ts.SyntaxKind.ArrowFunction:
      return arrowFunctionEnglish(node as ts.ArrowFunction)
    case ts.SyntaxKind.FunctionExpression:
      return functionExpressionEnglish(node as ts.FunctionExpression)
    case ts.SyntaxKind.ClassExpression:
      return classLikeEnglish(node as ts.ClassExpression, 'class expression')
    case ts.SyntaxKind.AsExpression: {
      const asNode = node as ts.AsExpression
      return clause('as-type', [
        { label: '', child: expressionEnglish(asNode.expression) },
        { label: 'treated as type', child: typeEnglish(asNode.type) },
      ])
    }
    case ts.SyntaxKind.SatisfiesExpression: {
      const satisfiesNode = node as ts.SatisfiesExpression
      return clause('satisfies-type', [
        { label: '', child: expressionEnglish(satisfiesNode.expression) },
        { label: 'checked to satisfy type', child: typeEnglish(satisfiesNode.type) },
      ])
    }
    case ts.SyntaxKind.NonNullExpression: {
      const inner = expressionEnglish((node as ts.NonNullExpression).expression)
      // `!` is postfix and needs no source parentheses, so a structured inner
      // expression gets explicit grouping — otherwise `user!.name` and
      // `user.name!` would render identically.
      return seq('non-null', [inner.kind === 'atom' ? inner : grouped(inner), atom('label', 'asserted non-null')])
    }
    case ts.SyntaxKind.TypeAssertionExpression: {
      const assertion = node as ts.TypeAssertion
      return clause('type-assertion', [
        { label: 'cast to type', child: typeEnglish(assertion.type) },
        slot('the value', expressionEnglish(assertion.expression)),
      ])
    }
    case ts.SyntaxKind.ExpressionWithTypeArguments: {
      const withArgs = node as ts.ExpressionWithTypeArguments
      return clause('expression-with-type-arguments', [
        { label: '', child: expressionEnglish(withArgs.expression) },
        ...typeArgumentsSegment(withArgs.typeArguments),
      ])
    }
    case ts.SyntaxKind.MetaProperty: {
      const meta = node as ts.MetaProperty
      const keyword = meta.keywordToken === ts.SyntaxKind.NewKeyword ? 'new' : 'import'
      return atom('meta-property', `\`${keyword}.${meta.name.text}\``)
    }
    case ts.SyntaxKind.OmittedExpression:
      return atom('hole', 'a hole')
    case ts.SyntaxKind.JsxElement:
    case ts.SyntaxKind.JsxSelfClosingElement:
    case ts.SyntaxKind.JsxFragment:
      return jsxEnglish(node as ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment)
    default:
      unsupported(node.kind)
  }
}

// ---------------------------------------------------------------------------
// Bindings, parameters, modifiers
// ---------------------------------------------------------------------------

function bindingNameEnglish(name: ts.BindingName): EnglishNode {
  if (ts.isIdentifier(name)) return nameAtom(name.text)
  if (ts.isObjectBindingPattern(name)) {
    return clause('object-pattern', [
      { label: 'an object pattern binding', list: name.elements.map(objectBindingElementEnglish) },
    ])
  }
  return clause('array-pattern', [
    { label: 'an array pattern binding', list: name.elements.map(arrayBindingElementEnglish) },
  ])
}

function objectBindingElementEnglish(element: ts.BindingElement): EnglishNode {
  const segments: EnglishSegment[] = []
  if (element.dotDotDotToken) {
    segments.push({ label: 'bind the remaining properties to', child: bindingNameEnglish(element.name) })
  } else if (element.propertyName) {
    segments.push({ label: 'bind property', child: objectPropertyName(element.propertyName) })
    segments.push({ label: 'to', child: bindingNameEnglish(element.name) })
  } else {
    segments.push({ label: 'bind property', child: bindingNameEnglish(element.name) })
  }
  if (element.initializer) segments.push(slot('with default', expressionEnglish(element.initializer)))
  return clause('binding-element', segments)
}

function arrayBindingElementEnglish(element: ts.ArrayBindingElement, index: number): EnglishNode {
  if (element.kind === ts.SyntaxKind.OmittedExpression) return atom('hole', `skip element ${index}`)
  const segments: EnglishSegment[] = []
  if (element.dotDotDotToken) {
    segments.push({ label: 'bind the remaining elements to', child: bindingNameEnglish(element.name) })
  } else {
    segments.push({ label: `bind element ${index} to`, child: bindingNameEnglish(element.name) })
  }
  if (element.initializer) segments.push(slot('with default', expressionEnglish(element.initializer)))
  return clause('binding-element', segments)
}

// Total by type: `ts.getModifiers` (every caller's source) only yields real
// modifier tokens, and a TypeScript upgrade that adds a ModifierSyntaxKind
// breaks this record at compile time instead of degrading the English.
export const MODIFIER_WORDS: Readonly<Record<ts.ModifierSyntaxKind, string>> = {
  [ts.SyntaxKind.ExportKeyword]: 'exported',
  [ts.SyntaxKind.DefaultKeyword]: 'as default',
  [ts.SyntaxKind.DeclareKeyword]: 'ambient',
  [ts.SyntaxKind.AbstractKeyword]: 'abstract',
  [ts.SyntaxKind.PublicKeyword]: 'public',
  [ts.SyntaxKind.PrivateKeyword]: 'private',
  [ts.SyntaxKind.ProtectedKeyword]: 'protected',
  [ts.SyntaxKind.StaticKeyword]: 'static',
  [ts.SyntaxKind.OverrideKeyword]: 'override',
  [ts.SyntaxKind.ReadonlyKeyword]: 'readonly',
  [ts.SyntaxKind.AccessorKeyword]: 'accessor',
  [ts.SyntaxKind.AsyncKeyword]: 'asynchronous',
  [ts.SyntaxKind.ConstKeyword]: 'const',
  [ts.SyntaxKind.InKeyword]: 'in',
  [ts.SyntaxKind.OutKeyword]: 'out',
}

/** Modifier words in source order — source order is deterministic and keeps
 *  the English reversible to the exact modifier list. */
function modifierWords(modifiers: readonly ts.Modifier[] | undefined): string[] {
  if (!modifiers) return []
  return modifiers.map((modifier) => MODIFIER_WORDS[modifier.kind])
}

function joinWords(words: string[]): string {
  return words.filter((word) => word !== '').join(' ')
}

function decoratorSegments(node: ts.HasDecorators): EnglishSegment[] {
  const decorators = ts.getDecorators(node)
  if (!decorators || decorators.length === 0) return []
  return [
    {
      label: 'decorated with',
      list: decorators.map((decorator) =>
        clause('decorator', [slot('decorator', expressionEnglish(decorator.expression))]),
      ),
    },
  ]
}

function parameterEnglish(parameter: ts.ParameterDeclaration): EnglishNode {
  const words = modifierWords(ts.getModifiers(parameter))
  const kind = parameter.dotDotDotToken ? 'rest parameter' : parameter.questionToken ? 'optional parameter' : 'parameter'
  const segments: EnglishSegment[] = [
    ...decoratorSegments(parameter),
    { label: joinWords([...words, kind]), child: bindingNameEnglish(parameter.name) },
  ]
  if (parameter.type) segments.push({ label: 'with type', child: typeEnglish(parameter.type) })
  if (parameter.initializer) segments.push(slot('with default', expressionEnglish(parameter.initializer)))
  return clause('parameter', segments)
}

function parametersSegment(parameters: ts.NodeArray<ts.ParameterDeclaration>): EnglishSegment {
  if (parameters.length === 0) return { label: 'with no parameters' }
  return { label: 'parameters', list: parameters.map(parameterEnglish) }
}

function typeParametersSegment(typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): EnglishSegment[] {
  if (!typeParameters || typeParameters.length === 0) return []
  return [{ label: 'with type parameters', list: typeParameters.map(typeParameterEnglish) }]
}

function typeParameterEnglish(typeParameter: ts.TypeParameterDeclaration): EnglishNode {
  const words = modifierWords(ts.getModifiers(typeParameter))
  const segments: EnglishSegment[] = [
    { label: joinWords([...words, 'type parameter']), child: nameAtom(typeParameter.name.text) },
  ]
  if (typeParameter.constraint) segments.push({ label: 'constrained to', child: typeEnglish(typeParameter.constraint) })
  if (typeParameter.default) segments.push({ label: 'with default', child: typeEnglish(typeParameter.default) })
  return clause('type-parameter', segments)
}

function returnTypeSegment(type: ts.TypeNode | undefined): EnglishSegment[] {
  if (!type) return []
  return [{ label: 'return type', child: typeEnglish(type), separate: true }]
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function statementsEnglish(statements: readonly ts.Statement[]): EnglishNode {
  if (statements.length === 0) return atom('no-statements', 'no statements')
  return clause(
    'statements',
    statements.map((statement) => ({ label: '', child: statementEnglish(statement) })),
    'block',
  )
}

function branchEnglish(statement: ts.Statement): EnglishNode {
  return statementsEnglish(ts.isBlock(statement) ? statement.statements : [statement])
}

function declarationKindWord(list: ts.VariableDeclarationList): string {
  const flags = ts.getCombinedNodeFlags(list)
  if ((flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing) return 'asynchronously disposable constant'
  if (flags & ts.NodeFlags.Using) return 'disposable constant'
  if (flags & ts.NodeFlags.Const) return 'constant'
  if (flags & ts.NodeFlags.Let) return 'variable'
  return 'function-scoped variable'
}

function declaratorEnglish(declaration: ts.VariableDeclaration, kindWord: string, headWords: string[]): EnglishNode {
  const segments: EnglishSegment[] = [
    { label: joinWords(['declare', ...headWords, kindWord]), child: bindingNameEnglish(declaration.name) },
  ]
  if (declaration.exclamationToken) segments.push({ label: 'asserted as definitely assigned' })
  if (declaration.type) segments.push({ label: 'with type', child: typeEnglish(declaration.type) })
  if (declaration.initializer) segments.push(slot('and initialize it to', expressionEnglish(declaration.initializer)))
  return clause('declare', segments)
}

function declarationListEnglish(list: ts.VariableDeclarationList, headWords: string[]): EnglishNode {
  const kindWord = declarationKindWord(list)
  const declarators = list.declarations.map((declaration) => declaratorEnglish(declaration, kindWord, headWords))
  if (declarators.length === 1) return declarators[0]
  return clause('variable-statement', [{ label: 'in one declaration statement', list: declarators }], 'block')
}

function forEnglish(node: ts.ForStatement): EnglishNode {
  const segments: EnglishSegment[] = [{ label: 'for loop' }]
  if (node.initializer) {
    const setup = ts.isVariableDeclarationList(node.initializer)
      ? declarationListEnglish(node.initializer, [])
      : expressionEnglish(node.initializer)
    segments.push({ label: 'setup', child: setup, separate: true })
  }
  if (node.condition) segments.push({ label: 'continue while', child: conditionEnglish(node.condition) })
  if (node.incrementor) segments.push(slot('after each pass', expressionEnglish(node.incrementor)))
  segments.push({ label: 'body', child: branchEnglish(node.statement), separate: true })
  return clause('for', segments, 'block')
}

function forEachEnglish(node: ts.ForOfStatement | ts.ForInStatement): EnglishNode {
  const isForOf = ts.isForOfStatement(node)
  const awaitWord = isForOf && node.awaitModifier ? 'for await each' : 'for each'
  const target = ts.isVariableDeclarationList(node.initializer)
    ? {
        label: joinWords([awaitWord, declarationKindWord(node.initializer)]),
        child: bindingNameEnglish(node.initializer.declarations[0].name),
      }
    : { label: `${awaitWord} assigning to`, child: expressionEnglish(node.initializer) }
  return clause(
    isForOf ? 'for-of' : 'for-in',
    [
      target,
      { label: isForOf ? 'from iterable' : 'from the enumerable keys of', child: expressionEnglish(node.expression) },
      { label: 'body', child: branchEnglish(node.statement), separate: true },
    ],
    'block',
  )
}

function switchEnglish(node: ts.SwitchStatement): EnglishNode {
  const segments: EnglishSegment[] = [{ label: 'switch on', child: expressionEnglish(node.expression) }]
  for (const caseClause of node.caseBlock.clauses) {
    const body: EnglishSegment[] =
      caseClause.statements.length > 0
        ? [{ label: 'body', child: statementsEnglish(caseClause.statements), separate: true }]
        : []
    segments.push(
      ts.isCaseClause(caseClause)
        ? {
            label: '',
            child: clause('case', [{ label: 'when case matches', child: expressionEnglish(caseClause.expression) }, ...body], 'block'),
          }
        : { label: '', child: clause('default-case', [{ label: 'the default case' }, ...body], 'block') },
    )
  }
  return clause('switch', segments, 'block')
}

function tryEnglish(node: ts.TryStatement): EnglishNode {
  const segments: EnglishSegment[] = [{ label: 'try', child: statementsEnglish(node.tryBlock.statements), separate: true }]
  if (node.catchClause) {
    if (node.catchClause.variableDeclaration) {
      segments.push({ label: 'on error caught as', child: bindingNameEnglish(node.catchClause.variableDeclaration.name) })
    }
    segments.push({ label: 'catch', child: statementsEnglish(node.catchClause.block.statements), separate: true })
  }
  if (node.finallyBlock) {
    segments.push({ label: 'finally', child: statementsEnglish(node.finallyBlock.statements), separate: true })
  }
  return clause('try', segments, 'block')
}

export function statementEnglish(node: ts.Statement): EnglishNode {
  switch (node.kind) {
    case ts.SyntaxKind.VariableStatement: {
      const statement = node as ts.VariableStatement
      return declarationListEnglish(statement.declarationList, modifierWords(ts.getModifiers(statement)))
    }
    case ts.SyntaxKind.ExpressionStatement:
      return expressionEnglish((node as ts.ExpressionStatement).expression)
    case ts.SyntaxKind.IfStatement: {
      const statement = node as ts.IfStatement
      const segments: EnglishSegment[] = [
        { label: 'if', child: conditionEnglish(statement.expression) },
        { label: 'then', child: branchEnglish(statement.thenStatement), separate: true },
      ]
      if (statement.elseStatement) {
        segments.push({ label: 'otherwise', child: branchEnglish(statement.elseStatement), separate: true })
      }
      return clause('if', segments, 'block')
    }
    case ts.SyntaxKind.ReturnStatement: {
      const statement = node as ts.ReturnStatement
      if (!statement.expression) return atom('return', 'return')
      return clause('return', [slot('return', expressionEnglish(statement.expression))])
    }
    case ts.SyntaxKind.ThrowStatement:
      return clause('throw', [slot('throw', expressionEnglish((node as ts.ThrowStatement).expression))])
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.ForInStatement:
      return forEachEnglish(node as ts.ForOfStatement | ts.ForInStatement)
    case ts.SyntaxKind.ForStatement:
      return forEnglish(node as ts.ForStatement)
    case ts.SyntaxKind.WhileStatement: {
      const statement = node as ts.WhileStatement
      return clause(
        'while',
        [
          { label: 'while', child: conditionEnglish(statement.expression) },
          { label: 'body', child: branchEnglish(statement.statement), separate: true },
        ],
        'block',
      )
    }
    case ts.SyntaxKind.DoStatement: {
      const statement = node as ts.DoStatement
      return clause(
        'do-while',
        [
          { label: 'do', child: branchEnglish(statement.statement), separate: true },
          { label: 'then repeat while', child: conditionEnglish(statement.expression) },
        ],
        'block',
      )
    }
    case ts.SyntaxKind.SwitchStatement:
      return switchEnglish(node as ts.SwitchStatement)
    case ts.SyntaxKind.TryStatement:
      return tryEnglish(node as ts.TryStatement)
    case ts.SyntaxKind.BreakStatement: {
      const label = (node as ts.BreakStatement).label
      return label ? seq('break', [atom('label', 'break to label'), nameAtom(label.text)]) : atom('break', 'break')
    }
    case ts.SyntaxKind.ContinueStatement: {
      const label = (node as ts.ContinueStatement).label
      return label ? seq('continue', [atom('label', 'continue to label'), nameAtom(label.text)]) : atom('continue', 'continue')
    }
    case ts.SyntaxKind.LabeledStatement: {
      const statement = node as ts.LabeledStatement
      return clause(
        'labeled',
        [
          { label: 'labeled', child: nameAtom(statement.label.text) },
          { label: '', child: statementEnglish(statement.statement) },
        ],
        'block',
      )
    }
    case ts.SyntaxKind.Block:
      return clause('block', [{ label: 'block', child: statementsEnglish((node as ts.Block).statements), separate: true }], 'block')
    case ts.SyntaxKind.EmptyStatement:
      return atom('empty-statement', 'an empty statement')
    case ts.SyntaxKind.DebuggerStatement:
      return atom('debugger', 'trigger the debugger')
    case ts.SyntaxKind.WithStatement: {
      const statement = node as ts.WithStatement
      return clause(
        'with',
        [
          { label: 'with scope from', child: expressionEnglish(statement.expression) },
          { label: 'body', child: branchEnglish(statement.statement), separate: true },
        ],
        'block',
      )
    }
    case ts.SyntaxKind.FunctionDeclaration:
      return functionDeclarationEnglish(node as ts.FunctionDeclaration)
    case ts.SyntaxKind.ClassDeclaration: {
      const declaration = node as ts.ClassDeclaration
      const head = joinWords(['declare', ...modifierWords(ts.getModifiers(declaration)), 'class'])
      return classLikeEnglish(declaration, head)
    }
    case ts.SyntaxKind.InterfaceDeclaration:
      return interfaceEnglish(node as ts.InterfaceDeclaration)
    case ts.SyntaxKind.TypeAliasDeclaration:
      return typeAliasEnglish(node as ts.TypeAliasDeclaration)
    case ts.SyntaxKind.EnumDeclaration:
      return enumEnglish(node as ts.EnumDeclaration)
    case ts.SyntaxKind.ModuleDeclaration:
      return moduleEnglish(node as ts.ModuleDeclaration)
    case ts.SyntaxKind.ImportDeclaration:
      return importEnglish(node as ts.ImportDeclaration)
    case ts.SyntaxKind.ImportEqualsDeclaration:
      return importEqualsEnglish(node as ts.ImportEqualsDeclaration)
    case ts.SyntaxKind.ExportDeclaration:
      return exportEnglish(node as ts.ExportDeclaration)
    case ts.SyntaxKind.ExportAssignment: {
      const assignment = node as ts.ExportAssignment
      const label = assignment.isExportEquals ? 'export equals' : 'export as default'
      return clause('export-assignment', [slot(label, expressionEnglish(assignment.expression))])
    }
    case ts.SyntaxKind.NamespaceExportDeclaration:
      return clause('namespace-export-declaration', [
        { label: 'export as the global namespace', child: nameAtom((node as ts.NamespaceExportDeclaration).name.text) },
      ])
    default:
      unsupported(node.kind)
  }
}

export type ReadableStructuredStatement =
  | ts.Block
  | ts.DoStatement
  | ts.ForInStatement
  | ts.ForOfStatement
  | ts.ForStatement
  | ts.IfStatement
  | ts.SwitchStatement
  | ts.TryStatement
  | ts.WhileStatement

function statementClause(node: ReadableStructuredStatement): EnglishClause {
  // Every member of ReadableStructuredStatement is constructed as a clause in
  // statementEnglish. Keeping the union here means adding a non-clause form is
  // a deliberate edit at this single adapter boundary.
  return statementEnglish(node) as EnglishClause
}

/** Canonical statement wording without its recursively rendered body. The
 * readable-test tree owns the body as source-linked child nodes, so rendering
 * the full statement here would duplicate those children. All words are
 * projected from statementEnglish's IR; this is not a second vocabulary. */
export function statementHeaderEnglish(node: ReadableStructuredStatement): EnglishNode {
  const english = statementClause(node)
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isSwitchStatement(node)) {
    return clause(english.tag, [english.segments[0]], english.layout)
  }
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    return clause(english.tag, english.segments.slice(0, -1), english.layout)
  }
  if (ts.isDoStatement(node)) {
    return clause(
      english.tag,
      [{ label: english.segments[0].label }, english.segments[1]],
      english.layout,
    )
  }
  return clause(english.tag, [{ label: english.segments[0].label }], english.layout)
}

export function ifPathHeaderEnglish(node: ts.IfStatement, path: 'then' | 'otherwise'): EnglishNode {
  const english = statementClause(node)
  const segment = english.segments[path === 'then' ? 1 : 2]
  return atom('if-path', segment.label)
}

export function switchPathHeaderEnglish(node: ts.SwitchStatement, index: number): EnglishNode {
  const english = statementClause(node)
  const path = english.segments[index + 1].child as EnglishClause
  return clause(path.tag, [path.segments[0]], path.layout)
}

export function catchHeaderEnglish(node: ts.TryStatement): EnglishNode {
  const english = statementClause(node)
  if (node.catchClause?.variableDeclaration) {
    return clause('catch-header', [english.segments[1]])
  }
  return atom('catch-header', english.segments[1].label)
}

export function finallyHeaderEnglish(node: ts.TryStatement): EnglishNode {
  const english = statementClause(node)
  return atom('finally-header', english.segments[english.segments.length - 1].label)
}

// ---------------------------------------------------------------------------
// Declarations and members
// ---------------------------------------------------------------------------

function functionDeclarationEnglish(node: ts.FunctionDeclaration): EnglishNode {
  const words = modifierWords(ts.getModifiers(node))
  const head = joinWords(['declare', ...words, node.asteriskToken ? 'generator' : '', 'function'])
  const segments: EnglishSegment[] = [
    node.name ? { label: head, child: nameAtom(node.name.text) } : { label: head },
    ...typeParametersSegment(node.typeParameters),
    parametersSegment(node.parameters),
    ...returnTypeSegment(node.type),
  ]
  if (node.body) segments.push({ label: 'body', child: statementsEnglish(node.body.statements), separate: true })
  else segments.push({ label: 'with no body' })
  return clause('function-declaration', segments, 'block')
}

function classLikeEnglish(node: ts.ClassLikeDeclaration, head: string): EnglishNode {
  const segments: EnglishSegment[] = [
    ...decoratorSegments(node),
    node.name ? { label: head, child: nameAtom(node.name.text) } : { label: head },
    ...typeParametersSegment(node.typeParameters),
  ]
  for (const heritage of node.heritageClauses ?? []) {
    if (heritage.token === ts.SyntaxKind.ExtendsKeyword) {
      segments.push({ label: 'extending', child: expressionEnglish(heritage.types[0]) })
    } else {
      segments.push({ label: 'implementing', list: heritage.types.map(expressionEnglish) })
    }
  }
  if (node.members.length === 0) segments.push({ label: 'with no members' })
  else segments.push({ label: 'members', list: node.members.map(classMemberEnglish) })
  return clause(ts.isClassExpression(node) ? 'class-expression' : 'class-declaration', segments, 'block')
}

function classMemberEnglish(member: ts.ClassElement): EnglishNode {
  switch (member.kind) {
    case ts.SyntaxKind.PropertyDeclaration: {
      const property = member as ts.PropertyDeclaration
      const words = modifierWords(ts.getModifiers(property))
      const kind = property.questionToken ? 'optional field' : 'field'
      const segments: EnglishSegment[] = [
        ...decoratorSegments(property),
        { label: joinWords([...words, kind]), child: objectPropertyName(property.name) },
      ]
      if (property.exclamationToken) segments.push({ label: 'asserted as definitely assigned' })
      if (property.type) segments.push({ label: 'with type', child: typeEnglish(property.type) })
      if (property.initializer) segments.push(slot('and initialize it to', expressionEnglish(property.initializer)))
      return clause('field', segments)
    }
    case ts.SyntaxKind.MethodDeclaration:
      return methodEnglish(member as ts.MethodDeclaration)
    case ts.SyntaxKind.Constructor: {
      const constructor = member as ts.ConstructorDeclaration
      const segments: EnglishSegment[] = [{ label: 'constructor' }, parametersSegment(constructor.parameters)]
      if (constructor.body) segments.push({ label: 'body', child: statementsEnglish(constructor.body.statements), separate: true })
      else segments.push({ label: 'with no body' })
      return clause('constructor', segments, 'block')
    }
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return accessorEnglish(member as ts.AccessorDeclaration)
    case ts.SyntaxKind.ClassStaticBlockDeclaration:
      return clause(
        'static-block',
        [
          { label: 'static initialization block' },
          { label: 'body', child: statementsEnglish((member as ts.ClassStaticBlockDeclaration).body.statements), separate: true },
        ],
        'block',
      )
    case ts.SyntaxKind.IndexSignature:
      return indexSignatureEnglish(member as ts.IndexSignatureDeclaration)
    case ts.SyntaxKind.SemicolonClassElement:
      return atom('empty-member', 'an empty class member')
    default:
      unsupported(member.kind)
  }
}

function methodEnglish(node: ts.MethodDeclaration): EnglishNode {
  const words = modifierWords(ts.getModifiers(node))
  const kind = joinWords([
    ...words,
    node.asteriskToken ? 'generator' : '',
    node.questionToken ? 'optional method' : 'method',
  ])
  const segments: EnglishSegment[] = [
    ...decoratorSegments(node),
    { label: kind, child: objectPropertyName(node.name) },
    ...typeParametersSegment(node.typeParameters),
    parametersSegment(node.parameters),
    ...returnTypeSegment(node.type),
  ]
  if (node.body) segments.push({ label: 'body', child: statementsEnglish(node.body.statements), separate: true })
  else segments.push({ label: 'with no body' })
  return clause('method', segments, 'block')
}

function accessorEnglish(node: ts.AccessorDeclaration): EnglishNode {
  const words = modifierWords(ts.getModifiers(node))
  const kind = ts.isGetAccessor(node) ? 'getter' : 'setter'
  const segments: EnglishSegment[] = [
    ...decoratorSegments(node),
    { label: joinWords([...words, kind]), child: objectPropertyName(node.name) },
    ...(node.parameters.length > 0 ? [parametersSegment(node.parameters)] : []),
    ...returnTypeSegment(node.type),
  ]
  if (node.body) segments.push({ label: 'body', child: statementsEnglish(node.body.statements), separate: true })
  else segments.push({ label: 'with no body' })
  return clause(kind, segments, 'block')
}

function indexSignatureEnglish(node: ts.IndexSignatureDeclaration): EnglishNode {
  const words = modifierWords(ts.getModifiers(node))
  const parameter = node.parameters[0]
  return clause('index-signature', [
    { label: joinWords([...words, 'index signature key']), child: bindingNameEnglish(parameter.name) },
    // The parser guarantees an index-signature parameter carries a type.
    { label: 'of key type', child: typeEnglish(parameter.type as ts.TypeNode) },
    { label: 'with value type', child: typeEnglish(node.type) },
  ])
}

function interfaceEnglish(node: ts.InterfaceDeclaration): EnglishNode {
  const head = joinWords(['declare', ...modifierWords(ts.getModifiers(node)), 'interface'])
  const segments: EnglishSegment[] = [
    { label: head, child: nameAtom(node.name.text) },
    ...typeParametersSegment(node.typeParameters),
  ]
  for (const heritage of node.heritageClauses ?? []) {
    segments.push({ label: 'extending', list: heritage.types.map(expressionEnglish) })
  }
  if (node.members.length === 0) segments.push({ label: 'with no members' })
  else segments.push({ label: 'members', list: node.members.map(typeMemberEnglish) })
  return clause('interface', segments, 'block')
}

function typeMemberEnglish(member: ts.TypeElement): EnglishNode {
  switch (member.kind) {
    case ts.SyntaxKind.PropertySignature: {
      const property = member as ts.PropertySignature
      const words = modifierWords(ts.getModifiers(property))
      const kind = property.questionToken ? 'optional property' : 'property'
      const segments: EnglishSegment[] = [{ label: joinWords([...words, kind]), child: objectPropertyName(property.name) }]
      if (property.type) segments.push({ label: 'with type', child: typeEnglish(property.type) })
      return clause('property-signature', segments)
    }
    case ts.SyntaxKind.MethodSignature: {
      const method = member as ts.MethodSignature
      const kind = method.questionToken ? 'optional method' : 'method'
      return clause('method-signature', [
        { label: kind, child: objectPropertyName(method.name) },
        ...typeParametersSegment(method.typeParameters),
        parametersSegment(method.parameters),
        ...returnTypeSegment(method.type),
      ])
    }
    case ts.SyntaxKind.CallSignature: {
      const signature = member as ts.CallSignatureDeclaration
      return clause('call-signature', [
        { label: 'call signature' },
        ...typeParametersSegment(signature.typeParameters),
        parametersSegment(signature.parameters),
        ...returnTypeSegment(signature.type),
      ])
    }
    case ts.SyntaxKind.ConstructSignature: {
      const signature = member as ts.ConstructSignatureDeclaration
      return clause('construct-signature', [
        { label: 'construct signature' },
        ...typeParametersSegment(signature.typeParameters),
        parametersSegment(signature.parameters),
        ...returnTypeSegment(signature.type),
      ])
    }
    case ts.SyntaxKind.IndexSignature:
      return indexSignatureEnglish(member as ts.IndexSignatureDeclaration)
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return accessorEnglish(member as ts.AccessorDeclaration)
    default:
      unsupported(member.kind)
  }
}

function typeAliasEnglish(node: ts.TypeAliasDeclaration): EnglishNode {
  const head = joinWords(['declare', ...modifierWords(ts.getModifiers(node)), 'type alias'])
  return clause('type-alias', [
    { label: head, child: nameAtom(node.name.text) },
    ...typeParametersSegment(node.typeParameters),
    { label: 'as', child: typeEnglish(node.type) },
  ])
}

function enumEnglish(node: ts.EnumDeclaration): EnglishNode {
  const head = joinWords(['declare', ...modifierWords(ts.getModifiers(node)), 'enum'])
  const members = node.members.map((member) => {
    const segments: EnglishSegment[] = [{ label: 'member', child: objectPropertyName(member.name) }]
    if (member.initializer) segments.push(slot('with value', expressionEnglish(member.initializer)))
    return clause('enum-member', segments)
  })
  const segments: EnglishSegment[] = [{ label: head, child: nameAtom(node.name.text) }]
  if (members.length === 0) segments.push({ label: 'with no members' })
  else segments.push({ label: 'members', list: members })
  return clause('enum', segments, 'block')
}

function moduleEnglish(node: ts.ModuleDeclaration): EnglishNode {
  const words = modifierWords(ts.getModifiers(node))
  const isGlobal = (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0
  const kind = isGlobal ? 'global augmentation' : node.flags & ts.NodeFlags.Namespace ? 'namespace' : 'module'
  const segments: EnglishSegment[] = []
  if (isGlobal) {
    segments.push({ label: joinWords(['declare', ...words, kind]) })
  } else {
    const name = ts.isStringLiteral(node.name)
      ? atom('string', `string ${JSON.stringify(node.name.text)}`)
      : nameAtom(node.name.text)
    segments.push({ label: joinWords(['declare', ...words, kind]), child: name })
  }
  if (!node.body) segments.push({ label: 'with no body' })
  else if (ts.isModuleBlock(node.body)) {
    segments.push({ label: 'body', child: statementsEnglish(node.body.statements), separate: true })
  } else {
    // A dotted namespace (`namespace a.b {}`) nests a ModuleDeclaration as its body.
    segments.push({ label: 'body', child: statementEnglish(node.body as ts.ModuleDeclaration), separate: true })
  }
  return clause('module', segments, 'block')
}

// ---------------------------------------------------------------------------
// Imports and exports
// ---------------------------------------------------------------------------

function moduleSpecifierEnglish(specifier: ts.Expression): EnglishNode {
  return expressionEnglish(specifier)
}

function importAttributesSegment(attributes: ts.ImportAttributes | undefined): EnglishSegment[] {
  if (!attributes || attributes.elements.length === 0) return []
  const items = attributes.elements.map((attribute) => {
    const name = ts.isStringLiteral(attribute.name)
      ? atom('string', `string ${JSON.stringify(attribute.name.text)}`)
      : nameAtom(attribute.name.text)
    return clause('import-attribute', [
      { label: 'attribute', child: name },
      slot('set to', expressionEnglish(attribute.value)),
    ])
  })
  return [{ label: 'with attributes', list: items }]
}

function importSpecifierEnglish(specifier: ts.ImportSpecifier | ts.ExportSpecifier): EnglishNode {
  const exported = specifier.propertyName
  const parts: EnglishNode[] = []
  if (specifier.isTypeOnly) parts.push(atom('label', 'type-only'))
  if (exported) {
    const exportedName = ts.isIdentifier(exported) ? nameAtom(exported.text) : moduleExportNameEnglish(exported)
    parts.push(exportedName, atom('label', 'as'))
  }
  parts.push(ts.isIdentifier(specifier.name) ? nameAtom(specifier.name.text) : moduleExportNameEnglish(specifier.name))
  return seq('binding', parts)
}

function moduleExportNameEnglish(name: ts.ModuleExportName): EnglishNode {
  return ts.isStringLiteral(name) ? atom('string', `string ${JSON.stringify(name.text)}`) : nameAtom(name.text)
}

function importEnglish(node: ts.ImportDeclaration): EnglishNode {
  const importClause = node.importClause
  if (!importClause) {
    return clause('import', [
      { label: 'import for side effects from', child: moduleSpecifierEnglish(node.moduleSpecifier) },
      ...importAttributesSegment(node.attributes),
    ])
  }
  const segments: EnglishSegment[] = [{ label: importClause.isTypeOnly ? 'import type' : 'import' }]
  if (importClause.name) segments.push({ label: 'the default binding as', child: nameAtom(importClause.name.text) })
  if (importClause.namedBindings) {
    if (ts.isNamespaceImport(importClause.namedBindings)) {
      segments.push({ label: 'the namespace as', child: nameAtom(importClause.namedBindings.name.text) })
    } else {
      segments.push({ label: 'named bindings', list: importClause.namedBindings.elements.map(importSpecifierEnglish) })
    }
  }
  segments.push({ label: 'from', child: moduleSpecifierEnglish(node.moduleSpecifier) })
  segments.push(...importAttributesSegment(node.attributes))
  return clause('import', segments)
}

function importEqualsEnglish(node: ts.ImportEqualsDeclaration): EnglishNode {
  const reference = node.moduleReference
  const target = ts.isExternalModuleReference(reference)
    ? clause('require', [{ label: 'require of', child: moduleSpecifierEnglish(reference.expression) }])
    : nameAtom(entityNameText(reference))
  const head = node.isTypeOnly ? 'import type' : 'import'
  return clause('import-equals', [
    { label: head, child: nameAtom(node.name.text) },
    { label: 'as an alias for', child: target },
  ])
}

function exportEnglish(node: ts.ExportDeclaration): EnglishNode {
  const head = node.isTypeOnly ? 'export type' : 'export'
  const segments: EnglishSegment[] = []
  if (!node.exportClause) {
    segments.push({ label: `${head} everything` })
  } else if (ts.isNamespaceExport(node.exportClause)) {
    segments.push({ label: head })
    segments.push({ label: 'the namespace as', child: moduleExportNameEnglish(node.exportClause.name) })
  } else {
    segments.push({ label: head })
    segments.push({ label: 'named bindings', list: node.exportClause.elements.map(importSpecifierEnglish) })
  }
  if (node.moduleSpecifier) segments.push({ label: 'from', child: moduleSpecifierEnglish(node.moduleSpecifier) })
  segments.push(...importAttributesSegment(node.attributes))
  return clause('export', segments)
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function jsxTagNameEnglish(name: ts.JsxTagNameExpression): EnglishNode {
  if (name.kind === ts.SyntaxKind.JsxNamespacedName) {
    return nameAtom(`${name.namespace.text}:${name.name.text}`)
  }
  return expressionEnglish(name)
}

function jsxAttributesSegment(attributes: ts.JsxAttributes): EnglishSegment[] {
  if (attributes.properties.length === 0) return []
  const items = attributes.properties.map((attribute) => {
    if (ts.isJsxSpreadAttribute(attribute)) {
      return seq('spread', [atom('label', 'spread attributes of'), expressionEnglish(attribute.expression)])
    }
    const name =
      attribute.name.kind === ts.SyntaxKind.JsxNamespacedName
        ? nameAtom(`${attribute.name.namespace.text}:${attribute.name.name.text}`)
        : nameAtom(attribute.name.text)
    const segments: EnglishSegment[] = [{ label: 'attribute', child: name }]
    if (attribute.initializer) segments.push(slot('set to', jsxAttributeValueEnglish(attribute.initializer)))
    return clause('jsx-attribute', segments)
  })
  return [{ label: 'with attributes', list: items }]
}

function jsxAttributeValueEnglish(value: ts.JsxAttributeValue): EnglishNode {
  if (ts.isJsxExpression(value)) return jsxExpressionEnglish(value)
  return expressionEnglish(value)
}

function jsxExpressionEnglish(node: ts.JsxExpression): EnglishNode {
  if (!node.expression) return atom('jsx-expression', 'an empty JSX expression')
  const inner = expressionEnglish(node.expression)
  if (node.dotDotDotToken) return clause('jsx-expression', [slot('the spread expression', inner)])
  return clause('jsx-expression', [slot('the expression', inner)])
}

function jsxChildrenSegment(children: ts.NodeArray<ts.JsxChild>): EnglishSegment[] {
  const items: EnglishNode[] = []
  for (const child of children) {
    switch (child.kind) {
      case ts.SyntaxKind.JsxText:
        // Pure-whitespace text between elements is formatting, not content.
        if (!child.containsOnlyTriviaWhiteSpaces) items.push(atom('jsx-text', `text ${JSON.stringify(child.text)}`))
        break
      case ts.SyntaxKind.JsxExpression:
        items.push(jsxExpressionEnglish(child))
        break
      default:
        items.push(jsxEnglish(child))
    }
  }
  if (items.length === 0) return []
  return [{ label: 'children', list: items }]
}

function jsxEnglish(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment): EnglishNode {
  if (ts.isJsxSelfClosingElement(node)) {
    return clause(
      'jsx-element',
      [
        { label: 'self-closing JSX element', child: jsxTagNameEnglish(node.tagName) },
        ...jsxAttributesSegment(node.attributes),
      ],
      'block',
    )
  }
  if (ts.isJsxFragment(node)) {
    return clause('jsx-fragment', [{ label: 'JSX fragment' }, ...jsxChildrenSegment(node.children)], 'block')
  }
  return clause(
    'jsx-element',
    [
      { label: 'JSX element', child: jsxTagNameEnglish(node.openingElement.tagName) },
      ...jsxAttributesSegment(node.openingElement.attributes),
      ...jsxChildrenSegment(node.children),
    ],
    'block',
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const KEYWORD_TYPE_WORDS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.AnyKeyword, 'any'],
  [ts.SyntaxKind.UnknownKeyword, 'unknown'],
  [ts.SyntaxKind.NeverKeyword, 'never'],
  [ts.SyntaxKind.VoidKeyword, 'void'],
  [ts.SyntaxKind.UndefinedKeyword, 'undefined'],
  [ts.SyntaxKind.StringKeyword, 'string'],
  [ts.SyntaxKind.NumberKeyword, 'number'],
  [ts.SyntaxKind.BooleanKeyword, 'boolean'],
  [ts.SyntaxKind.BigIntKeyword, 'bigint'],
  [ts.SyntaxKind.SymbolKeyword, 'symbol'],
  [ts.SyntaxKind.ObjectKeyword, 'object'],
  [ts.SyntaxKind.IntrinsicKeyword, 'intrinsic'],
])

// Total by type: TypeOperatorNode.operator admits exactly these three kinds,
// so a TypeScript upgrade that widens the union fails compilation here.
const TYPE_OPERATOR_PHRASES: Readonly<Record<ts.TypeOperatorNode['operator'], string>> = {
  [ts.SyntaxKind.KeyOfKeyword]: 'the keys of',
  [ts.SyntaxKind.UniqueKeyword]: 'unique',
  [ts.SyntaxKind.ReadonlyKeyword]: 'readonly',
}

export function typeEnglish(node: ts.TypeNode): EnglishNode {
  const keywordWord = KEYWORD_TYPE_WORDS.get(node.kind)
  if (keywordWord) return atom('keyword-type', keywordWord)
  switch (node.kind) {
    case ts.SyntaxKind.TypeReference: {
      const reference = node as ts.TypeReferenceNode
      const name = nameAtom(entityNameText(reference.typeName))
      if (!reference.typeArguments || reference.typeArguments.length === 0) return name
      return clause('type-reference', [{ label: 'type', child: name }, ...typeArgumentsSegment(reference.typeArguments)])
    }
    case ts.SyntaxKind.UnionType:
      return clause('union-type', [{ label: 'union type of', list: (node as ts.UnionTypeNode).types.map(typeEnglish) }])
    case ts.SyntaxKind.IntersectionType:
      return clause('intersection-type', [
        { label: 'intersection type of', list: (node as ts.IntersectionTypeNode).types.map(typeEnglish) },
      ])
    case ts.SyntaxKind.ArrayType:
      return clause('array-type', [{ label: 'array type of', child: typeEnglish((node as ts.ArrayTypeNode).elementType) }])
    case ts.SyntaxKind.TupleType: {
      const tuple = node as ts.TupleTypeNode
      if (tuple.elements.length === 0) return clause('tuple-type', [{ label: 'an empty tuple type' }])
      return clause('tuple-type', [{ label: 'tuple type of', list: tuple.elements.map(typeEnglish) }])
    }
    case ts.SyntaxKind.NamedTupleMember: {
      const member = node as ts.NamedTupleMember
      const kind = member.dotDotDotToken ? 'rest member' : member.questionToken ? 'optional member' : 'member'
      return clause('named-tuple-member', [
        { label: kind, child: nameAtom(member.name.text) },
        { label: 'with type', child: typeEnglish(member.type) },
      ])
    }
    case ts.SyntaxKind.OptionalType:
      return clause('optional-type', [{ label: 'optional', child: typeEnglish((node as ts.OptionalTypeNode).type) }])
    case ts.SyntaxKind.RestType:
      return clause('rest-type', [{ label: 'rest of', child: typeEnglish((node as ts.RestTypeNode).type) }])
    case ts.SyntaxKind.ParenthesizedType:
      return grouped(typeEnglish((node as ts.ParenthesizedTypeNode).type))
    case ts.SyntaxKind.LiteralType:
      return expressionEnglish((node as ts.LiteralTypeNode).literal as ts.Expression)
    case ts.SyntaxKind.FunctionType: {
      const functionType = node as ts.FunctionTypeNode
      return clause('function-type', [
        { label: 'function type' },
        ...typeParametersSegment(functionType.typeParameters),
        parametersSegment(functionType.parameters),
        { label: 'returning', child: typeEnglish(functionType.type) },
      ])
    }
    case ts.SyntaxKind.ConstructorType: {
      const constructorType = node as ts.ConstructorTypeNode
      const words = modifierWords(ts.getModifiers(constructorType))
      return clause('constructor-type', [
        { label: joinWords([...words, 'constructor type']) },
        ...typeParametersSegment(constructorType.typeParameters),
        parametersSegment(constructorType.parameters),
        { label: 'returning', child: typeEnglish(constructorType.type) },
      ])
    }
    case ts.SyntaxKind.TypeQuery: {
      const query = node as ts.TypeQueryNode
      return clause('type-query', [
        { label: 'the type of', child: nameAtom(entityNameText(query.exprName)) },
        ...typeArgumentsSegment(query.typeArguments),
      ])
    }
    case ts.SyntaxKind.TypeOperator: {
      const operator = node as ts.TypeOperatorNode
      return seq('type-operator', [atom('operator', TYPE_OPERATOR_PHRASES[operator.operator]), typeEnglish(operator.type)])
    }
    case ts.SyntaxKind.IndexedAccessType: {
      const indexed = node as ts.IndexedAccessTypeNode
      return clause('indexed-access-type', [
        { label: 'indexed access of', child: typeEnglish(indexed.objectType) },
        { label: 'at', child: typeEnglish(indexed.indexType) },
      ])
    }
    case ts.SyntaxKind.ConditionalType: {
      const conditional = node as ts.ConditionalTypeNode
      return clause('conditional-type', [
        { label: 'conditional type: if', child: typeEnglish(conditional.checkType) },
        { label: 'extends', child: typeEnglish(conditional.extendsType) },
        { label: 'then', child: typeEnglish(conditional.trueType), separate: true },
        { label: 'otherwise', child: typeEnglish(conditional.falseType), separate: true },
      ])
    }
    case ts.SyntaxKind.InferType:
      return clause('infer-type', [
        { label: 'infer', child: typeParameterEnglish((node as ts.InferTypeNode).typeParameter) },
      ])
    case ts.SyntaxKind.ThisType:
      return atom('this-type', 'the `this` type')
    case ts.SyntaxKind.TypeLiteral: {
      const literal = node as ts.TypeLiteralNode
      if (literal.members.length === 0) return clause('type-literal', [{ label: 'an empty object type' }])
      return clause('type-literal', [{ label: 'an object type with', list: literal.members.map(typeMemberEnglish) }])
    }
    case ts.SyntaxKind.MappedType: {
      const mapped = node as ts.MappedTypeNode
      const segments: EnglishSegment[] = [
        { label: 'mapped type with key', child: nameAtom(mapped.typeParameter.name.text) },
        // The parser requires the `in` constraint of a mapped-type parameter.
        { label: 'in', child: typeEnglish(mapped.typeParameter.constraint as ts.TypeNode) },
      ]
      if (mapped.nameType) segments.push({ label: 'renamed as', child: typeEnglish(mapped.nameType) })
      if (mapped.readonlyToken) {
        segments.push({
          label:
            mapped.readonlyToken.kind === ts.SyntaxKind.MinusToken
              ? 'removing readonly'
              : mapped.readonlyToken.kind === ts.SyntaxKind.PlusToken
                ? 'adding readonly'
                : 'marked readonly',
        })
      }
      if (mapped.questionToken) {
        segments.push({
          label:
            mapped.questionToken.kind === ts.SyntaxKind.MinusToken
              ? 'removing optionality'
              : mapped.questionToken.kind === ts.SyntaxKind.PlusToken
                ? 'adding optionality'
                : 'marked optional',
        })
      }
      if (mapped.type) segments.push({ label: 'with value type', child: typeEnglish(mapped.type) })
      return clause('mapped-type', segments, 'block')
    }
    case ts.SyntaxKind.TemplateLiteralType: {
      const template = node as ts.TemplateLiteralTypeNode
      const items: EnglishNode[] = []
      if (template.head.text !== '') items.push(atom('template-text', `text ${JSON.stringify(template.head.text)}`))
      for (const span of template.templateSpans) {
        items.push(seq('template-type-value', [atom('label', 'value of type'), typeEnglish(span.type)]))
        if (span.literal.text !== '') items.push(atom('template-text', `text ${JSON.stringify(span.literal.text)}`))
      }
      return clause('template-literal-type', [{ label: 'template string type joining', list: items }])
    }
    case ts.SyntaxKind.TypePredicate: {
      const predicate = node as ts.TypePredicateNode
      const subject =
        predicate.parameterName.kind === ts.SyntaxKind.ThisType ? atom('this', '`this`') : nameAtom(predicate.parameterName.text)
      if (predicate.assertsModifier) {
        if (!predicate.type) return clause('type-predicate', [{ label: 'asserts', child: subject }])
        return clause('type-predicate', [
          { label: 'asserts that', child: subject },
          { label: 'is', child: typeEnglish(predicate.type) },
        ])
      }
      return clause('type-predicate', [
        { label: 'type predicate', child: subject },
        // A non-asserts predicate always carries a type (`x is T`).
        { label: 'is', child: typeEnglish(predicate.type as ts.TypeNode) },
      ])
    }
    case ts.SyntaxKind.ImportType: {
      const importType = node as ts.ImportTypeNode
      const segments: EnglishSegment[] = []
      if (importType.isTypeOf) segments.push({ label: 'the type of' })
      segments.push({ label: 'type imported from', child: typeEnglish(importType.argument) })
      if (importType.qualifier) segments.push({ label: 'member', child: nameAtom(entityNameText(importType.qualifier)) })
      segments.push(...typeArgumentsSegment(importType.typeArguments))
      if (importType.attributes) segments.push(...importAttributesSegment(importType.attributes))
      return clause('import-type', segments)
    }
    default:
      unsupported(node.kind)
  }
}

// ---------------------------------------------------------------------------
// Source files and comments
// ---------------------------------------------------------------------------

// Each top-level statement's leading trivia starts where the previous
// statement ended, and the end-of-file token's starts after the last
// statement — the scanned ranges are disjoint, so no dedupe is needed.
function commentAtoms(sourceFile: ts.SourceFile, position: number): EnglishNode[] {
  const fullText = sourceFile.getFullText()
  const ranges = ts.getLeadingCommentRanges(fullText, position) ?? []
  const atoms: EnglishNode[] = []
  for (const range of ranges) {
    const text = fullText.slice(range.pos, range.end)
    for (const line of text.split('\n')) atoms.push(atom('comment', `comment: ${line.trim()}`))
  }
  return atoms
}

/** Whole-file translation: statements in order, each preceded by its leading
 *  comments rendered explicitly as `comment:` lines (never as program facts).
 *  Comments after the last statement hang off the end-of-file token. */
export function sourceFileEnglish(sourceFile: ts.SourceFile): EnglishNode {
  const segments: EnglishSegment[] = []
  for (const statement of sourceFile.statements) {
    for (const comment of commentAtoms(sourceFile, statement.getFullStart())) {
      segments.push({ label: '', child: comment })
    }
    segments.push({ label: '', child: statementEnglish(statement) })
  }
  for (const comment of commentAtoms(sourceFile, sourceFile.endOfFileToken.getFullStart())) {
    segments.push({ label: '', child: comment })
  }
  if (segments.length === 0) return atom('no-statements', 'no statements')
  return clause('source-file', segments, 'block')
}
