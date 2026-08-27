import ts from 'typescript'

// Complete classification of every SyntaxKind the pinned TypeScript compiler
// defines (see compiler-context.ts for the version contract). Every distinct
// enum value is listed exactly once under its canonical (first-declared,
// non-marker) name; First*/Last*/Count range markers and deprecated aliases
// (AssertClause → ImportAttributes) are alias values of these rows, not kinds
// of their own. `syntax-kinds.test.ts` proves this table total against the
// installed compiler in both directions.

export type KindCategory =
  | 'internal'
  | 'trivia'
  | 'literal'
  | 'token'
  | 'operator'
  | 'keyword'
  | 'modifier'
  | 'name'
  | 'binding'
  | 'expression'
  | 'statement'
  | 'declaration'
  | 'class-member'
  | 'type'
  | 'module'
  | 'clause'
  | 'jsx'
  | 'jsdoc'

export type KindDisposition =
  // Has a controlled-English form of its own (a vocabulary entry).
  | 'translated'
  // Rendered as part of its owning construct's form (a template span inside a
  // template expression, a case clause inside a switch).
  | 'structural-child'
  // Surfaces through the operator vocabulary, never as a free-standing node.
  | 'operator-token'
  // Surfaces through the construct whose grammar the keyword belongs to.
  | 'keyword-token'
  // Surfaces through the modifier vocabulary.
  | 'modifier'
  // Pure syntax the owning construct's English grammar already expresses.
  | 'punctuation'
  // The comment channel: never a program fact (see semantic-boundaries.md).
  | 'trivia'
  // JSDoc structures: comment channel, kept apart from executable syntax.
  | 'jsdoc'
  // Synthetic/transform/recovery nodes a parse of source text never yields.
  | 'compiler-internal'

export interface SyntaxKindInfo {
  name: string
  category: KindCategory
  disposition: KindDisposition
  typescriptOnly?: true
  note?: string
}

function k(
  name: string,
  category: KindCategory,
  disposition: KindDisposition,
  extra?: { typescriptOnly?: true; note?: string },
): SyntaxKindInfo {
  return { name, category, disposition, ...extra }
}

export const SYNTAX_KIND_INFO: readonly SyntaxKindInfo[] = [
  k('Unknown', 'internal', 'compiler-internal', { note: 'scanner error placeholder' }),
  k('EndOfFileToken', 'token', 'punctuation', { note: 'end-of-input marker on every SourceFile' }),
  k('SingleLineCommentTrivia', 'trivia', 'trivia'),
  k('MultiLineCommentTrivia', 'trivia', 'trivia'),
  k('NewLineTrivia', 'trivia', 'trivia'),
  k('WhitespaceTrivia', 'trivia', 'trivia'),
  k('ShebangTrivia', 'trivia', 'trivia'),
  k('ConflictMarkerTrivia', 'trivia', 'trivia', { note: 'merge-conflict markers the scanner tolerates' }),
  k('NonTextFileMarkerTrivia', 'internal', 'compiler-internal', { note: 'marks non-text source files' }),
  k('NumericLiteral', 'literal', 'translated'),
  k('BigIntLiteral', 'literal', 'translated'),
  k('StringLiteral', 'literal', 'translated'),
  k('JsxText', 'jsx', 'translated'),
  k('JsxTextAllWhiteSpaces', 'internal', 'compiler-internal', { note: 'scanner-side whitespace classification of JsxText' }),
  k('RegularExpressionLiteral', 'literal', 'translated'),
  k('NoSubstitutionTemplateLiteral', 'literal', 'translated'),
  k('TemplateHead', 'literal', 'structural-child', { note: 'text chunk of a template expression' }),
  k('TemplateMiddle', 'literal', 'structural-child', { note: 'text chunk of a template expression' }),
  k('TemplateTail', 'literal', 'structural-child', { note: 'text chunk of a template expression' }),
  k('OpenBraceToken', 'token', 'punctuation'),
  k('CloseBraceToken', 'token', 'punctuation'),
  k('OpenParenToken', 'token', 'punctuation'),
  k('CloseParenToken', 'token', 'punctuation'),
  k('OpenBracketToken', 'token', 'punctuation'),
  k('CloseBracketToken', 'token', 'punctuation'),
  k('DotToken', 'token', 'punctuation'),
  k('DotDotDotToken', 'token', 'punctuation', { note: 'spread/rest, expressed by the owning construct' }),
  k('SemicolonToken', 'token', 'punctuation'),
  k('CommaToken', 'token', 'punctuation'),
  k('QuestionDotToken', 'token', 'punctuation', { note: 'optional chaining, expressed by the owning access/call' }),
  k('LessThanToken', 'operator', 'operator-token', { note: 'also generic/JSX punctuation' }),
  k('LessThanSlashToken', 'token', 'punctuation', { note: 'JSX closing-tag punctuation' }),
  k('GreaterThanToken', 'operator', 'operator-token', { note: 'also generic/JSX punctuation' }),
  k('LessThanEqualsToken', 'operator', 'operator-token'),
  k('GreaterThanEqualsToken', 'operator', 'operator-token'),
  k('EqualsEqualsToken', 'operator', 'operator-token'),
  k('ExclamationEqualsToken', 'operator', 'operator-token'),
  k('EqualsEqualsEqualsToken', 'operator', 'operator-token'),
  k('ExclamationEqualsEqualsToken', 'operator', 'operator-token'),
  k('EqualsGreaterThanToken', 'token', 'punctuation', { note: 'arrow-function punctuation' }),
  k('PlusToken', 'operator', 'operator-token'),
  k('MinusToken', 'operator', 'operator-token'),
  k('AsteriskToken', 'operator', 'operator-token', { note: 'also the generator marker' }),
  k('AsteriskAsteriskToken', 'operator', 'operator-token'),
  k('SlashToken', 'operator', 'operator-token'),
  k('PercentToken', 'operator', 'operator-token'),
  k('PlusPlusToken', 'operator', 'operator-token'),
  k('MinusMinusToken', 'operator', 'operator-token'),
  k('LessThanLessThanToken', 'operator', 'operator-token'),
  k('GreaterThanGreaterThanToken', 'operator', 'operator-token'),
  k('GreaterThanGreaterThanGreaterThanToken', 'operator', 'operator-token'),
  k('AmpersandToken', 'operator', 'operator-token', { note: 'also intersection-type punctuation' }),
  k('BarToken', 'operator', 'operator-token', { note: 'also union-type punctuation' }),
  k('CaretToken', 'operator', 'operator-token'),
  k('ExclamationToken', 'operator', 'operator-token', { note: 'also the definite-assignment/non-null marker' }),
  k('TildeToken', 'operator', 'operator-token'),
  k('AmpersandAmpersandToken', 'operator', 'operator-token'),
  k('BarBarToken', 'operator', 'operator-token'),
  k('QuestionToken', 'token', 'punctuation', { note: 'optionality/conditional punctuation' }),
  k('ColonToken', 'token', 'punctuation'),
  k('AtToken', 'token', 'punctuation', { note: 'decorator punctuation' }),
  k('QuestionQuestionToken', 'operator', 'operator-token'),
  k('BacktickToken', 'token', 'punctuation'),
  k('HashToken', 'token', 'punctuation', { note: 'private-name punctuation' }),
  k('EqualsToken', 'operator', 'operator-token'),
  k('PlusEqualsToken', 'operator', 'operator-token'),
  k('MinusEqualsToken', 'operator', 'operator-token'),
  k('AsteriskEqualsToken', 'operator', 'operator-token'),
  k('AsteriskAsteriskEqualsToken', 'operator', 'operator-token'),
  k('SlashEqualsToken', 'operator', 'operator-token'),
  k('PercentEqualsToken', 'operator', 'operator-token'),
  k('LessThanLessThanEqualsToken', 'operator', 'operator-token'),
  k('GreaterThanGreaterThanEqualsToken', 'operator', 'operator-token'),
  k('GreaterThanGreaterThanGreaterThanEqualsToken', 'operator', 'operator-token'),
  k('AmpersandEqualsToken', 'operator', 'operator-token'),
  k('BarEqualsToken', 'operator', 'operator-token'),
  k('BarBarEqualsToken', 'operator', 'operator-token'),
  k('AmpersandAmpersandEqualsToken', 'operator', 'operator-token'),
  k('QuestionQuestionEqualsToken', 'operator', 'operator-token'),
  k('CaretEqualsToken', 'operator', 'operator-token'),
  k('Identifier', 'name', 'translated'),
  k('PrivateIdentifier', 'name', 'translated'),
  k('JSDocCommentTextToken', 'jsdoc', 'jsdoc'),
  k('BreakKeyword', 'keyword', 'keyword-token'),
  k('CaseKeyword', 'keyword', 'keyword-token'),
  k('CatchKeyword', 'keyword', 'keyword-token'),
  k('ClassKeyword', 'keyword', 'keyword-token'),
  k('ConstKeyword', 'keyword', 'modifier', { note: 'const type-parameter modifier; const declarations carry a NodeFlag' }),
  k('ContinueKeyword', 'keyword', 'keyword-token'),
  k('DebuggerKeyword', 'keyword', 'keyword-token'),
  k('DefaultKeyword', 'keyword', 'modifier'),
  k('DeleteKeyword', 'keyword', 'keyword-token'),
  k('DoKeyword', 'keyword', 'keyword-token'),
  k('ElseKeyword', 'keyword', 'keyword-token'),
  k('EnumKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('ExportKeyword', 'keyword', 'modifier'),
  k('ExtendsKeyword', 'keyword', 'keyword-token'),
  k('FalseKeyword', 'keyword', 'translated', { note: 'a literal expression node' }),
  k('FinallyKeyword', 'keyword', 'keyword-token'),
  k('ForKeyword', 'keyword', 'keyword-token'),
  k('FunctionKeyword', 'keyword', 'keyword-token'),
  k('IfKeyword', 'keyword', 'keyword-token'),
  k('ImportKeyword', 'keyword', 'translated', { note: 'the callee of a dynamic import call' }),
  k('InKeyword', 'operator', 'operator-token', { note: 'also the in/out variance modifier and for-in punctuation' }),
  k('InstanceOfKeyword', 'operator', 'operator-token'),
  k('NewKeyword', 'keyword', 'keyword-token'),
  k('NullKeyword', 'keyword', 'translated', { note: 'a literal expression node' }),
  k('ReturnKeyword', 'keyword', 'keyword-token'),
  k('SuperKeyword', 'keyword', 'translated', { note: 'an expression node' }),
  k('SwitchKeyword', 'keyword', 'keyword-token'),
  k('ThisKeyword', 'keyword', 'translated', { note: 'an expression node' }),
  k('ThrowKeyword', 'keyword', 'keyword-token'),
  k('TrueKeyword', 'keyword', 'translated', { note: 'a literal expression node' }),
  k('TryKeyword', 'keyword', 'keyword-token'),
  k('TypeOfKeyword', 'keyword', 'keyword-token'),
  k('VarKeyword', 'keyword', 'keyword-token'),
  k('VoidKeyword', 'keyword', 'translated', { note: 'the void type node; VoidExpression owns the operator form' }),
  k('WhileKeyword', 'keyword', 'keyword-token'),
  k('WithKeyword', 'keyword', 'keyword-token'),
  k('ImplementsKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('InterfaceKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('LetKeyword', 'keyword', 'keyword-token'),
  k('PackageKeyword', 'keyword', 'keyword-token', { note: 'reserved word with no owning construct' }),
  k('PrivateKeyword', 'keyword', 'modifier', { typescriptOnly: true }),
  k('ProtectedKeyword', 'keyword', 'modifier', { typescriptOnly: true }),
  k('PublicKeyword', 'keyword', 'modifier', { typescriptOnly: true }),
  k('StaticKeyword', 'keyword', 'modifier'),
  k('YieldKeyword', 'keyword', 'keyword-token'),
  k('AbstractKeyword', 'keyword', 'modifier', { typescriptOnly: true }),
  k('AccessorKeyword', 'keyword', 'modifier'),
  k('AsKeyword', 'keyword', 'keyword-token'),
  k('AssertsKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('AssertKeyword', 'keyword', 'keyword-token', { note: 'legacy import-assertion syntax' }),
  k('AnyKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('AsyncKeyword', 'keyword', 'modifier'),
  k('AwaitKeyword', 'keyword', 'keyword-token'),
  k('BooleanKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('ConstructorKeyword', 'keyword', 'keyword-token'),
  k('DeclareKeyword', 'keyword', 'modifier', { typescriptOnly: true }),
  k('GetKeyword', 'keyword', 'keyword-token'),
  k('InferKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('IntrinsicKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('IsKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('KeyOfKeyword', 'keyword', 'keyword-token', { typescriptOnly: true, note: 'a TypeOperator operator' }),
  k('ModuleKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('NamespaceKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('NeverKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('OutKeyword', 'keyword', 'modifier', { typescriptOnly: true }),
  k('ReadonlyKeyword', 'keyword', 'modifier', { typescriptOnly: true, note: 'also a TypeOperator operator' }),
  k('RequireKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('NumberKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('ObjectKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('SatisfiesKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('SetKeyword', 'keyword', 'keyword-token'),
  k('StringKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('SymbolKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('TypeKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('UndefinedKeyword', 'type', 'translated', { typescriptOnly: true, note: 'the undefined type node; the value form is an Identifier' }),
  k('UniqueKeyword', 'keyword', 'keyword-token', { typescriptOnly: true, note: 'a TypeOperator operator' }),
  k('UnknownKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('UsingKeyword', 'keyword', 'keyword-token'),
  k('FromKeyword', 'keyword', 'keyword-token'),
  k('GlobalKeyword', 'keyword', 'keyword-token', { typescriptOnly: true }),
  k('BigIntKeyword', 'type', 'translated', { typescriptOnly: true }),
  k('OverrideKeyword', 'keyword', 'modifier', { typescriptOnly: true }),
  k('OfKeyword', 'keyword', 'keyword-token'),
  k('DeferKeyword', 'keyword', 'keyword-token', { note: 'deferred dynamic import' }),
  k('QualifiedName', 'name', 'translated'),
  k('ComputedPropertyName', 'name', 'structural-child', { note: 'rendered as "named by" inside its owner' }),
  k('TypeParameter', 'declaration', 'translated', { typescriptOnly: true }),
  k('Parameter', 'declaration', 'translated'),
  k('Decorator', 'declaration', 'translated'),
  k('PropertySignature', 'class-member', 'translated', { typescriptOnly: true }),
  k('PropertyDeclaration', 'class-member', 'translated'),
  k('MethodSignature', 'class-member', 'translated', { typescriptOnly: true }),
  k('MethodDeclaration', 'class-member', 'translated'),
  k('ClassStaticBlockDeclaration', 'class-member', 'translated'),
  k('Constructor', 'class-member', 'translated'),
  k('GetAccessor', 'class-member', 'translated'),
  k('SetAccessor', 'class-member', 'translated'),
  k('CallSignature', 'class-member', 'translated', { typescriptOnly: true }),
  k('ConstructSignature', 'class-member', 'translated', { typescriptOnly: true }),
  k('IndexSignature', 'class-member', 'translated', { typescriptOnly: true }),
  k('TypePredicate', 'type', 'translated', { typescriptOnly: true }),
  k('TypeReference', 'type', 'translated', { typescriptOnly: true }),
  k('FunctionType', 'type', 'translated', { typescriptOnly: true }),
  k('ConstructorType', 'type', 'translated', { typescriptOnly: true }),
  k('TypeQuery', 'type', 'translated', { typescriptOnly: true }),
  k('TypeLiteral', 'type', 'translated', { typescriptOnly: true }),
  k('ArrayType', 'type', 'translated', { typescriptOnly: true }),
  k('TupleType', 'type', 'translated', { typescriptOnly: true }),
  k('OptionalType', 'type', 'translated', { typescriptOnly: true }),
  k('RestType', 'type', 'translated', { typescriptOnly: true }),
  k('UnionType', 'type', 'translated', { typescriptOnly: true }),
  k('IntersectionType', 'type', 'translated', { typescriptOnly: true }),
  k('ConditionalType', 'type', 'translated', { typescriptOnly: true }),
  k('InferType', 'type', 'translated', { typescriptOnly: true }),
  k('ParenthesizedType', 'type', 'translated', { typescriptOnly: true }),
  k('ThisType', 'type', 'translated', { typescriptOnly: true }),
  k('TypeOperator', 'type', 'translated', { typescriptOnly: true }),
  k('IndexedAccessType', 'type', 'translated', { typescriptOnly: true }),
  k('MappedType', 'type', 'translated', { typescriptOnly: true }),
  k('LiteralType', 'type', 'translated', { typescriptOnly: true }),
  k('NamedTupleMember', 'type', 'translated', { typescriptOnly: true }),
  k('TemplateLiteralType', 'type', 'translated', { typescriptOnly: true }),
  k('TemplateLiteralTypeSpan', 'type', 'structural-child', { typescriptOnly: true }),
  k('ImportType', 'type', 'translated', { typescriptOnly: true }),
  k('ObjectBindingPattern', 'binding', 'translated'),
  k('ArrayBindingPattern', 'binding', 'translated'),
  k('BindingElement', 'binding', 'structural-child', { note: 'wording depends on the owning pattern' }),
  k('ArrayLiteralExpression', 'expression', 'translated'),
  k('ObjectLiteralExpression', 'expression', 'translated'),
  k('PropertyAccessExpression', 'expression', 'translated'),
  k('ElementAccessExpression', 'expression', 'translated'),
  k('CallExpression', 'expression', 'translated'),
  k('NewExpression', 'expression', 'translated'),
  k('TaggedTemplateExpression', 'expression', 'translated'),
  k('TypeAssertionExpression', 'expression', 'translated', { typescriptOnly: true, note: 'the legacy <T>value cast' }),
  k('ParenthesizedExpression', 'expression', 'translated'),
  k('FunctionExpression', 'expression', 'translated'),
  k('ArrowFunction', 'expression', 'translated'),
  k('DeleteExpression', 'expression', 'translated'),
  k('TypeOfExpression', 'expression', 'translated'),
  k('VoidExpression', 'expression', 'translated'),
  k('AwaitExpression', 'expression', 'translated'),
  k('PrefixUnaryExpression', 'expression', 'translated'),
  k('PostfixUnaryExpression', 'expression', 'translated'),
  k('BinaryExpression', 'expression', 'translated'),
  k('ConditionalExpression', 'expression', 'translated'),
  k('TemplateExpression', 'expression', 'translated'),
  k('YieldExpression', 'expression', 'translated'),
  k('SpreadElement', 'expression', 'translated'),
  k('ClassExpression', 'expression', 'translated'),
  k('OmittedExpression', 'expression', 'translated', { note: 'an array hole' }),
  k('ExpressionWithTypeArguments', 'expression', 'translated'),
  k('AsExpression', 'expression', 'translated', { typescriptOnly: true }),
  k('NonNullExpression', 'expression', 'translated', { typescriptOnly: true }),
  k('MetaProperty', 'expression', 'translated'),
  k('SyntheticExpression', 'internal', 'compiler-internal'),
  k('SatisfiesExpression', 'expression', 'translated', { typescriptOnly: true }),
  k('TemplateSpan', 'expression', 'structural-child'),
  k('SemicolonClassElement', 'class-member', 'translated'),
  k('Block', 'statement', 'translated'),
  k('EmptyStatement', 'statement', 'translated'),
  k('VariableStatement', 'statement', 'translated'),
  k('ExpressionStatement', 'statement', 'translated'),
  k('IfStatement', 'statement', 'translated'),
  k('DoStatement', 'statement', 'translated'),
  k('WhileStatement', 'statement', 'translated'),
  k('ForStatement', 'statement', 'translated'),
  k('ForInStatement', 'statement', 'translated'),
  k('ForOfStatement', 'statement', 'translated'),
  k('ContinueStatement', 'statement', 'translated'),
  k('BreakStatement', 'statement', 'translated'),
  k('ReturnStatement', 'statement', 'translated'),
  k('WithStatement', 'statement', 'translated'),
  k('SwitchStatement', 'statement', 'translated'),
  k('LabeledStatement', 'statement', 'translated'),
  k('ThrowStatement', 'statement', 'translated'),
  k('TryStatement', 'statement', 'translated'),
  k('DebuggerStatement', 'statement', 'translated'),
  k('VariableDeclaration', 'declaration', 'structural-child'),
  k('VariableDeclarationList', 'declaration', 'structural-child'),
  k('FunctionDeclaration', 'declaration', 'translated'),
  k('ClassDeclaration', 'declaration', 'translated'),
  k('InterfaceDeclaration', 'declaration', 'translated', { typescriptOnly: true }),
  k('TypeAliasDeclaration', 'declaration', 'translated', { typescriptOnly: true }),
  k('EnumDeclaration', 'declaration', 'translated', { typescriptOnly: true }),
  k('ModuleDeclaration', 'declaration', 'translated', { typescriptOnly: true }),
  k('ModuleBlock', 'declaration', 'structural-child', { typescriptOnly: true }),
  k('CaseBlock', 'statement', 'structural-child'),
  k('NamespaceExportDeclaration', 'module', 'translated', { typescriptOnly: true }),
  k('ImportEqualsDeclaration', 'module', 'translated', { typescriptOnly: true }),
  k('ImportDeclaration', 'module', 'translated'),
  k('ImportClause', 'module', 'structural-child'),
  k('NamespaceImport', 'module', 'structural-child'),
  k('NamedImports', 'module', 'structural-child'),
  k('ImportSpecifier', 'module', 'structural-child'),
  k('ExportAssignment', 'module', 'translated', { note: 'export default and export= share this kind' }),
  k('ExportDeclaration', 'module', 'translated'),
  k('NamedExports', 'module', 'structural-child'),
  k('NamespaceExport', 'module', 'structural-child'),
  k('ExportSpecifier', 'module', 'structural-child'),
  k('MissingDeclaration', 'internal', 'compiler-internal', { note: 'parser error recovery' }),
  k('ExternalModuleReference', 'module', 'structural-child', { typescriptOnly: true }),
  k('JsxElement', 'jsx', 'translated'),
  k('JsxSelfClosingElement', 'jsx', 'translated'),
  k('JsxOpeningElement', 'jsx', 'structural-child'),
  k('JsxClosingElement', 'jsx', 'structural-child'),
  k('JsxFragment', 'jsx', 'translated'),
  k('JsxOpeningFragment', 'jsx', 'structural-child'),
  k('JsxClosingFragment', 'jsx', 'structural-child'),
  k('JsxAttribute', 'jsx', 'structural-child'),
  k('JsxAttributes', 'jsx', 'structural-child'),
  k('JsxSpreadAttribute', 'jsx', 'structural-child'),
  k('JsxExpression', 'jsx', 'translated', { note: 'also stands alone as a JSX child' }),
  k('JsxNamespacedName', 'jsx', 'structural-child'),
  k('CaseClause', 'clause', 'structural-child'),
  k('DefaultClause', 'clause', 'structural-child'),
  k('HeritageClause', 'clause', 'structural-child'),
  k('CatchClause', 'clause', 'structural-child'),
  k('ImportAttributes', 'module', 'structural-child'),
  k('ImportAttribute', 'module', 'structural-child'),
  k('ImportTypeAssertionContainer', 'type', 'structural-child', { typescriptOnly: true }),
  k('PropertyAssignment', 'expression', 'structural-child'),
  k('ShorthandPropertyAssignment', 'expression', 'structural-child'),
  k('SpreadAssignment', 'expression', 'structural-child'),
  k('EnumMember', 'declaration', 'structural-child', { typescriptOnly: true }),
  k('SourceFile', 'statement', 'translated', { note: 'the whole-file entry point' }),
  k('Bundle', 'internal', 'compiler-internal'),
  k('JSDocTypeExpression', 'jsdoc', 'jsdoc'),
  k('JSDocNameReference', 'jsdoc', 'jsdoc'),
  k('JSDocMemberName', 'jsdoc', 'jsdoc'),
  k('JSDocAllType', 'jsdoc', 'jsdoc'),
  k('JSDocUnknownType', 'jsdoc', 'jsdoc'),
  k('JSDocNullableType', 'jsdoc', 'jsdoc'),
  k('JSDocNonNullableType', 'jsdoc', 'jsdoc'),
  k('JSDocOptionalType', 'jsdoc', 'jsdoc'),
  k('JSDocFunctionType', 'jsdoc', 'jsdoc'),
  k('JSDocVariadicType', 'jsdoc', 'jsdoc'),
  k('JSDocNamepathType', 'jsdoc', 'jsdoc'),
  k('JSDoc', 'jsdoc', 'jsdoc'),
  k('JSDocText', 'jsdoc', 'jsdoc'),
  k('JSDocTypeLiteral', 'jsdoc', 'jsdoc'),
  k('JSDocSignature', 'jsdoc', 'jsdoc'),
  k('JSDocLink', 'jsdoc', 'jsdoc'),
  k('JSDocLinkCode', 'jsdoc', 'jsdoc'),
  k('JSDocLinkPlain', 'jsdoc', 'jsdoc'),
  k('JSDocTag', 'jsdoc', 'jsdoc'),
  k('JSDocAugmentsTag', 'jsdoc', 'jsdoc'),
  k('JSDocImplementsTag', 'jsdoc', 'jsdoc'),
  k('JSDocAuthorTag', 'jsdoc', 'jsdoc'),
  k('JSDocDeprecatedTag', 'jsdoc', 'jsdoc'),
  k('JSDocClassTag', 'jsdoc', 'jsdoc'),
  k('JSDocPublicTag', 'jsdoc', 'jsdoc'),
  k('JSDocPrivateTag', 'jsdoc', 'jsdoc'),
  k('JSDocProtectedTag', 'jsdoc', 'jsdoc'),
  k('JSDocReadonlyTag', 'jsdoc', 'jsdoc'),
  k('JSDocOverrideTag', 'jsdoc', 'jsdoc'),
  k('JSDocCallbackTag', 'jsdoc', 'jsdoc'),
  k('JSDocOverloadTag', 'jsdoc', 'jsdoc'),
  k('JSDocEnumTag', 'jsdoc', 'jsdoc'),
  k('JSDocParameterTag', 'jsdoc', 'jsdoc'),
  k('JSDocReturnTag', 'jsdoc', 'jsdoc'),
  k('JSDocThisTag', 'jsdoc', 'jsdoc'),
  k('JSDocTypeTag', 'jsdoc', 'jsdoc'),
  k('JSDocTemplateTag', 'jsdoc', 'jsdoc'),
  k('JSDocTypedefTag', 'jsdoc', 'jsdoc'),
  k('JSDocSeeTag', 'jsdoc', 'jsdoc'),
  k('JSDocPropertyTag', 'jsdoc', 'jsdoc'),
  k('JSDocThrowsTag', 'jsdoc', 'jsdoc'),
  k('JSDocSatisfiesTag', 'jsdoc', 'jsdoc'),
  k('JSDocImportTag', 'jsdoc', 'jsdoc'),
  k('SyntaxList', 'internal', 'compiler-internal'),
  k('NotEmittedStatement', 'internal', 'compiler-internal'),
  k('NotEmittedTypeElement', 'internal', 'compiler-internal'),
  k('PartiallyEmittedExpression', 'internal', 'compiler-internal'),
  k('CommaListExpression', 'internal', 'compiler-internal'),
  k('SyntheticReferenceExpression', 'internal', 'compiler-internal'),
]

/** Range markers and deprecated aliases share enum values with real kinds and
 *  are excluded from the classification. `Count` is the enum's size marker. */
export function isMarkerName(name: string): boolean {
  return /^(First|Last)[A-Z]/.test(name) || name === 'Count'
}

export const SYNTAX_KIND_INFO_BY_NAME: ReadonlyMap<string, SyntaxKindInfo> = new Map(
  SYNTAX_KIND_INFO.map((info) => [info.name, info]),
)

// The enum's reverse map (`ts.SyntaxKind[value]`) returns the LAST-declared
// name for a shared value, which is a deprecated alias for several kinds
// (AssertClause over ImportAttributes, JSDocComment over JSDoc). The canonical
// name is the FIRST-declared non-marker name, resolved once from the installed
// compiler so error messages and reports always use current terminology.
const canonicalNameByValue = new Map<number, string>()
for (const name of Object.keys(ts.SyntaxKind)) {
  if (/^\d/.test(name) || isMarkerName(name)) continue
  const value = ts.SyntaxKind[name as keyof typeof ts.SyntaxKind]
  if (!canonicalNameByValue.has(value)) canonicalNameByValue.set(value, name)
}

export function canonicalKindName(kind: number): string {
  const name = canonicalNameByValue.get(kind)
  return name === undefined ? `SyntaxKind ${kind}` : name
}
