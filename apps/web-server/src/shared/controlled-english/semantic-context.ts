import path from 'node:path'
import ts from 'typescript'
import type { ReadableSemanticRuleConfig } from '../../../../../shared/readable-tests/types'
import { scriptKindForFile } from './compiler-context'

export interface SemanticContext {
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
  config: Readonly<ReadableSemanticRuleConfig>
  /** False for a synthetic wrapper whose offsets do not address the real file. */
  absoluteSourceRanges: boolean
}

export interface CompileSemanticSourceOptions {
  compilerOptions?: ts.CompilerOptions
  semanticRules?: ReadableSemanticRuleConfig
  absoluteSourceRanges?: boolean
}

/** Build the binder/checker for one source document without making successful
 *  dependency installation a prerequisite. Import declarations and local
 *  aliases still have real Symbols; external modules are classified by their
 *  resolved import evidence rather than by ambiguous method names. */
export function compileSemanticSource(
  file: string,
  source: string,
  options: CompileSemanticSourceOptions = {},
): SemanticContext {
  const rootName = path.resolve(file)
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noEmit: true,
    noLib: true,
    noResolve: true,
    allowJs: true,
    checkJs: false,
    ...options.compilerOptions,
  }
  const host = ts.createCompilerHost(compilerOptions, true)
  const baseGetSourceFile = host.getSourceFile.bind(host)
  const baseFileExists = host.fileExists.bind(host)
  const sameFile = (candidate: string): boolean => path.resolve(candidate) === rootName

  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (sameFile(candidate)) {
      return ts.createSourceFile(
        rootName,
        source,
        languageVersion,
        true,
        scriptKindForFile(file),
      )
    }
    return baseGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile)
  }
  host.fileExists = (candidate) => sameFile(candidate) || baseFileExists(candidate)

  const program = ts.createProgram({ rootNames: [rootName], options: compilerOptions, host })
  // `rootName` is the sole program root and the host always returns it, so the
  // program necessarily owns this source file.
  const sourceFile = program.getSourceFile(rootName) as ts.SourceFile
  return {
    sourceFile,
    checker: program.getTypeChecker(),
    config: Object.freeze({
      ...(options.semanticRules?.apiClients
        ? { apiClients: Object.freeze([...options.semanticRules.apiClients]) }
        : {}),
      ...(options.semanticRules?.databaseClients
        ? { databaseClients: Object.freeze([...options.semanticRules.databaseClients]) }
        : {}),
    }),
    absoluteSourceRanges: options.absoluteSourceRanges ?? true,
  }
}

export interface SymbolEvidence {
  modules: string[]
  importedNames: string[]
  /** A declaration in this source shadows an ambient/global name. */
  declaredInSource: boolean
  fixture?: string
}

function importModuleFor(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node
  while (current && !ts.isImportDeclaration(current) && !ts.isImportEqualsDeclaration(current)) {
    current = current.parent
  }
  if (current && ts.isImportDeclaration(current) && ts.isStringLiteralLike(current.moduleSpecifier)) {
    return current.moduleSpecifier.text
  }
  if (
    current
    && ts.isImportEqualsDeclaration(current)
    && ts.isExternalModuleReference(current.moduleReference)
    && current.moduleReference.expression
    && ts.isStringLiteralLike(current.moduleReference.expression)
  ) {
    return current.moduleReference.expression.text
  }
  return undefined
}

function importedNameFor(node: ts.Node): string | undefined {
  if (ts.isImportSpecifier(node)) return node.propertyName?.text ?? node.name.text
  if (ts.isImportClause(node) && node.name) return 'default'
  if (ts.isNamespaceImport(node)) return '*'
  if (ts.isImportEqualsDeclaration(node)) return 'export='
  return undefined
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current = expression
  while (
    ts.isPropertyAccessExpression(current)
    || ts.isElementAccessExpression(current)
    || ts.isCallExpression(current)
    || ts.isNewExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isAwaitExpression(current)
  ) {
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) current = current.expression
    else if (ts.isElementAccessExpression(current) || ts.isPropertyAccessExpression(current)) current = current.expression
    else current = current.expression
  }
  return ts.isIdentifier(current) ? current : undefined
}

function containingParameter(binding: ts.BindingElement): ts.ParameterDeclaration | undefined {
  let current: ts.Node | undefined = binding.parent
  while (current && !ts.isParameter(current)) current = current.parent
  return current && ts.isParameter(current) ? current : undefined
}

function containingCallForParameter(parameter: ts.ParameterDeclaration): ts.CallExpression | undefined {
  const fn = parameter.parent
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined
  const call = fn.parent
  return ts.isCallExpression(call) ? call : undefined
}

const CLIENT_FACTORY_NAMES = new Set([
  'create',
  'createClient',
  'createConnection',
  'createPool',
  'connect',
])

function typeProvenanceRoot(type: ts.TypeNode): ts.Identifier | undefined {
  if (ts.isParenthesizedTypeNode(type)) return typeProvenanceRoot(type.type)
  if (!ts.isTypeReferenceNode(type)) return undefined
  let name = type.typeName
  while (ts.isQualifiedName(name)) name = name.left
  return name
}

/** Provenance follows aliases and client construction, not arbitrary returned
 *  data. In particular, `const res = await request.get()` must not make
 *  `res.json()` another external API call. */
function initializerProvenanceRoot(initializer: ts.Expression): ts.Identifier | undefined {
  let expression = initializer
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) {
    expression = expression.expression
  }
  if (ts.isNewExpression(expression)) return rootIdentifier(expression.expression)
  if (ts.isCallExpression(expression)) {
    const path = expression.expression
    const factoryName = ts.isIdentifier(path)
      ? path.text
      : ts.isPropertyAccessExpression(path)
        ? path.name.text
        : undefined
    return factoryName && CLIENT_FACTORY_NAMES.has(factoryName)
      ? rootIdentifier(expression.expression)
      : undefined
  }
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    return rootIdentifier(expression)
  }
  return undefined
}

/** Resolve the provenance of an identifier through its TypeChecker Symbol,
 *  import declaration, local initializer, or a proven Playwright fixture. */
export function symbolEvidence(
  identifier: ts.Identifier,
  context: SemanticContext,
  seen: ReadonlySet<ts.Symbol> = new Set(),
): SymbolEvidence {
  const symbol = context.checker.getSymbolAtLocation(identifier)
  if (!symbol || seen.has(symbol)) {
    return { modules: [], importedNames: [], declaredInSource: false }
  }
  const nextSeen = new Set(seen)
  nextSeen.add(symbol)
  const modules = new Set<string>()
  const importedNames = new Set<string>()
  let declaredInSource = false
  let fixture: string | undefined

  for (const declaration of symbol.declarations ?? []) {
    if (declaration.getSourceFile() === context.sourceFile) declaredInSource = true
    const importedFrom = importModuleFor(declaration)
    if (importedFrom) modules.add(importedFrom)
    const importedName = importedNameFor(declaration)
    if (importedName) importedNames.add(importedName)

    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const root = initializerProvenanceRoot(declaration.initializer)
      if (root) {
        const upstream = symbolEvidence(root, context, nextSeen)
        for (const moduleName of upstream.modules) modules.add(moduleName)
        for (const name of upstream.importedNames) importedNames.add(name)
        fixture ??= upstream.fixture
      }
    }

    if (
      (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
      && declaration.type
    ) {
      const root = typeProvenanceRoot(declaration.type)
      if (root) {
        const upstream = symbolEvidence(root, context, nextSeen)
        for (const moduleName of upstream.modules) modules.add(moduleName)
        for (const name of upstream.importedNames) importedNames.add(name)
      }
    }

    if (ts.isBindingElement(declaration) && ts.isIdentifier(declaration.name)) {
      const parameter = containingParameter(declaration)
      const call = parameter ? containingCallForParameter(parameter) : undefined
      const calleeRoot = call ? rootIdentifier(call.expression) : undefined
      if (calleeRoot) {
        const upstream = symbolEvidence(calleeRoot, context, nextSeen)
        if (upstream.modules.includes('@playwright/test')) {
          modules.add('@playwright/test')
          fixture = declaration.name.text
        }
      }
    }
  }

  return {
    modules: [...modules].sort(),
    importedNames: [...importedNames].sort(),
    declaredInSource,
    ...(fixture ? { fixture } : {}),
  }
}

export function rootIdentifierForExpression(expression: ts.Expression): ts.Identifier | undefined {
  return rootIdentifier(expression)
}
