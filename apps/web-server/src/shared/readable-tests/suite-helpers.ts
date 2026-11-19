import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { readSpecSource, SPEC_SCAN_EXCLUDED } from '../../../../../shared/spec-files'
import { compileSemanticSource, type SemanticContext } from '../controlled-english/semantic-context'
import { isPathUnder } from '../path-containment'
import { resolveImport } from '../relative-import'

export interface AuthoredHelper {
  file: string
  semanticContext: SemanticContext
  body: ts.ConciseBody
}

export type ResolveSuiteHelper = (name: ts.Identifier, context: SemanticContext) => AuthoredHelper | undefined

/** A roster read owns the cache. A later read sees helper edits, and a recorded
 * roster resolves modules strictly inside its own retained suite. */
export function suiteHelperResolver(root: string): ResolveSuiteHelper {
  const modules = new Map<string, SemanticContext>()
  const realRoot = fs.realpathSync(root)
  return (name, context) => {
    let symbol = context.checker.getSymbolAtLocation(name)
    const binding = symbol?.declarations?.[0]
    if (!binding) return
    if (ts.isImportSpecifier(binding) || ts.isImportClause(binding)) {
      const clause = ts.isImportClause(binding) ? binding : binding.parent.parent
      const specifier = clause.parent.moduleSpecifier
      if (clause.isTypeOnly || (ts.isImportSpecifier(binding) && binding.isTypeOnly) ||
          !ts.isStringLiteral(specifier) || !/^\.{1,2}\//.test(specifier.text)) return
      const importer = context.sourceFile.fileName
      const base = path.resolve(path.dirname(importer), specifier.text)
      if (!isPathUnder(base, root, false) && !isPathUnder(base, realRoot, false)) return
      let file: string
      try {
        const resolved = resolveImport(importer, specifier.text)
        if (!resolved) return
        file = fs.realpathSync(resolved)
        if (!isPathUnder(file, realRoot, false) || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) ||
            path.relative(realRoot, file).split(path.sep).some(part => SPEC_SCAN_EXCLUDED.has(part))) return
        let module = modules.get(file)
        if (!module) {
          module = compileSemanticSource(file, readSpecSource(file), { semanticRules: context.config })
          modules.set(file, module)
        }
        context = module
      } catch {
        // Editors can replace an import between directory lookup and read.
        return
      }
      const moduleSymbol = context.checker.getSymbolAtLocation(context.sourceFile)
      const exported = ts.isImportClause(binding) ? 'default' : (binding.propertyName ?? binding.name).text
      symbol = moduleSymbol && context.checker.getExportsOfModule(moduleSymbol).find(item => item.name === exported)
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = context.checker.getAliasedSymbol(symbol)
    }
    return helperFromSymbol(symbol, context)
  }
}

/** Resolve against the supplied revision only; a before/after buffer has no
 * authority to read an imported module from the current working tree. */
export const localSourceHelper: ResolveSuiteHelper = (name, context) =>
  helperFromSymbol(context.checker.getSymbolAtLocation(name), context)

function helperFromSymbol(symbol: ts.Symbol | undefined, context: SemanticContext): AuthoredHelper | undefined {
  const declaration = symbol?.valueDeclaration
  if (!declaration || declaration.getSourceFile() !== context.sourceFile) return
  const fn = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration
  if (fn && (ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body) {
    return { body: fn.body, file: context.sourceFile.fileName, semanticContext: context }
  }
}
