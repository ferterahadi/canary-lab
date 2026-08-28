import fs from 'fs'
import ts from 'typescript'
import { formatCodeForDisplay, formatSourceSnippetForDisplay } from '../../../../../../../shared/code-display-format'
import { assertionFor, collectDirectAssertions, dedupeAssertions, helperAssertion, isNoiseHelper } from './assertions'
import { calledIdentifier, functionBody, functionLikeBody, functionName, isAssertionCall, isPlaywrightTestCall, isWaitAssertionCall, lineFor, listSpecFiles, resolveImport, safeRead, stringArg } from './ast'
import { cleanSnippet, dedupe } from './text'
import type { HelperDefinition, ImportedHelper, SourceTest, TestReviewAssertion } from './types'

export function loadSourceTests(featureDir: string | undefined): Map<string, SourceTest> {
  const out = new Map<string, SourceTest>()
  if (!featureDir || !fs.existsSync(featureDir)) return out
  for (const file of listSpecFiles(featureDir)) {
    const source = safeRead(file)
    if (source === null) continue
    const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const imports = readRelativeImports(file, src)
    const externalImports = readExternalImports(src)
    const helpers = new Map<string, HelperDefinition>()
    const helperFor = (name: string): HelperDefinition | undefined => {
      if (helpers.has(name)) return helpers.get(name)
      const imported = imports.get(name) ?? (hasLocalDefinition(src, name) ? { name, file } : undefined)
      if (!imported) return undefined
      const resolved = readHelperDefinition(imported, new Set([`${file}:${name}`]))
      if (resolved) helpers.set(name, resolved)
      return resolved
    }

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && isPlaywrightTestCall(node)) {
        const title = stringArg(node, src)
        const body = functionBody(node)
        if (title && body) {
          const review = reviewTestBody(body, src, helperFor)
          out.set(`${file}:${lineFor(node, src)}`, {
            file,
            line: lineFor(node, src),
            title,
            bodySource: formatCodeForDisplay(body.getText(src)),
            helperCalls: review.helperCalls,
            helperDefinitions: review.helperDefinitions,
            externalImports: dedupe([
              ...externalImports,
              ...review.helperDefinitions.flatMap((helper) => flattenHelpers([helper]).flatMap((h) => h.externalImports)),
            ]),
            assertions: review.assertions,
          })
        }
        return
      }
      node.forEachChild(visit)
    }

    visit(src)
  }
  return out
}

export function readRelativeImports(file: string, src: ts.SourceFile): Map<string, ImportedHelper> {
  const imports = new Map<string, ImportedHelper>()
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const specifier = stmt.moduleSpecifier.text
    if (!specifier.startsWith('.')) continue
    const resolved = resolveImport(file, specifier)
    if (!resolved) continue
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) imports.set(clause.name.text, { name: clause.name.text, file: resolved })
    const named = clause.namedBindings
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        imports.set(element.name.text, {
          name: element.propertyName?.text ?? element.name.text,
          file: resolved,
        })
      }
    }
  }
  return imports
}

export function readExternalImports(src: ts.SourceFile): string[] {
  const imports: string[] = []
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text.startsWith('.')) continue
    imports.push(cleanSnippet(stmt.getText(src)))
  }
  return imports
}

export function readHelperDefinition(imported: ImportedHelper, seen: Set<string>): HelperDefinition | undefined {
  const source = safeRead(imported.file)
  if (source === null) return undefined
  const src = ts.createSourceFile(imported.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports = readRelativeImports(imported.file, src)
  const externalImports = readExternalImports(src)
  let found: HelperDefinition | undefined

  function visit(node: ts.Node): void {
    if (found) return
    const name = functionName(node)
    if (name !== imported.name) {
      node.forEachChild(visit)
      return
    }
    const body = functionLikeBody(node)
    const dependencies = body
      ? collectLocalDependencies(body, src, imported.file, imports, seen)
      : []
    found = {
      name,
      file: imported.file,
      snippet: cleanSnippet(node.getText(src)),
      ...(body
        ? {
            bodySource: formatSourceSnippetForDisplay(body.getText(src)),
            startLine: lineFor(body, src),
          }
        : {}),
      externalImports,
      dependencies,
      assertions: body ? collectDirectAssertions(body, src) : [],
    }
  }

  visit(src)
  return found
}

export function reviewTestBody(
  body: ts.Node,
  src: ts.SourceFile,
  helperFor: (name: string) => HelperDefinition | undefined,
): { helperCalls: string[]; helperDefinitions: HelperDefinition[]; assertions: TestReviewAssertion[] } {
  const helperCalls: string[] = []
  const helperDefinitions: HelperDefinition[] = []
  const assertions: TestReviewAssertion[] = []

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (isAssertionCall(node) || isWaitAssertionCall(node)) {
        assertions.push(assertionFor(node, src, 'direct'))
      } else {
        const name = calledIdentifier(node)
        // A bare `expect(...)` node is the receiver of an assertion chain we
        // already counted on the outer call — it is not a helper call, nor a
        // check of its own. Skip the built-in by name so it never registers as
        // a phantom unresolvable helper; custom assertion helpers like
        // `expectLoggedIn(...)` keep their distinct name and are still graded.
        if (name && name !== 'expect' && !isPlaywrightTestCall(node) && !isNoiseHelper(name)) {
          helperCalls.push(cleanSnippet(node.getText(src)))
          const helper = helperFor(name)
          if (helper) helperDefinitions.push(helper)
          if (name.startsWith('expect')) {
            assertions.push(helperAssertion(node, src, helper))
          }
        }
      }
    }
    node.forEachChild(visit)
  }

  visit(body)
  return {
    helperCalls: dedupe(helperCalls),
    helperDefinitions: dedupeHelpers(helperDefinitions),
    assertions: dedupeAssertions(assertions),
  }
}

export function collectLocalDependencies(
  body: ts.Node,
  src: ts.SourceFile,
  file: string,
  imports: Map<string, ImportedHelper>,
  seen: Set<string>,
): HelperDefinition[] {
  const dependencies: HelperDefinition[] = []

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = calledIdentifier(node)
      if (name && !isNoiseHelper(name)) {
        const imported = imports.get(name) ?? (hasLocalDefinition(src, name) ? { name, file } : undefined)
        const key = imported ? `${imported.file}:${imported.name}` : ''
        if (imported && !seen.has(key)) {
          const nextSeen = new Set(seen)
          nextSeen.add(key)
          const dependency = readHelperDefinition(imported, nextSeen)
          if (dependency) dependencies.push(dependency)
        }
      }
    }
    node.forEachChild(visit)
  }

  visit(body)
  return dedupeHelpers(dependencies)
}

export function hasLocalDefinition(src: ts.SourceFile, name: string): boolean {
  let found = false
  function visit(node: ts.Node): void {
    if (found) return
    if (functionName(node) === name) {
      found = true
      return
    }
    node.forEachChild(visit)
  }
  visit(src)
  return found
}

export function dedupeHelpers(helpers: HelperDefinition[]): HelperDefinition[] {
  const seen = new Set<string>()
  return helpers.filter((helper) => {
    const key = `${helper.file}:${helper.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function flattenHelpers(helpers: HelperDefinition[]): HelperDefinition[] {
  const out: HelperDefinition[] = []
  const seen = new Set<string>()
  const visit = (helper: HelperDefinition): void => {
    const key = `${helper.file}:${helper.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(helper)
    for (const dependency of helper.dependencies) visit(dependency)
  }
  for (const helper of helpers) visit(helper)
  return out
}
