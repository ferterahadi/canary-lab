import { playbackSourceNodes } from '../../../../shared/playback-source-declarations'
import { extractTestsFromSource } from '../../../../shared/ast-extractor'
import { codeDisplayAttacher } from '../../../../shared/readable-tests/code-display'
import type { ReadableSemanticRuleConfig } from '../../../../../../../shared/readable-tests/types'
import { scanSpecFiles } from '../../../../../../../shared/spec-files'
import { parseSource } from '../../../../shared/controlled-english/compiler-context'
import fs from 'fs'
import ts from 'typescript'
import { formatCodeForDisplay, formatSourceSnippetForDisplay } from '../../../../../../../shared/code-display-format'
import { assertionFor, collectDirectAssertions, dedupeAssertions, helperAssertion, isNoiseHelper } from './assertions'
import { calledIdentifier, functionLikeBody, functionName, isAssertionCall, isPlaywrightTestCall, isWaitAssertionCall, lineFor, resolveImport, safeRead } from './ast'
import { cleanSnippet, dedupe } from './text'
import type { HelperDefinition, ImportedHelper, SourceTest, TestReviewAssertion } from './types'

/** Every declared test in the suite with its body, helpers and checks, plus
 * the same extracted test the Tests column renders, so the report numbers its
 * English and code rows exactly as the web does. */
export function loadSourceTests(featureDir: string | undefined, semanticRules?: ReadableSemanticRuleConfig): Map<string, SourceTest> {
  const out = new Map<string, SourceTest>()
  if (!featureDir || !fs.existsSync(featureDir)) return out
  const withCodeDisplay = codeDisplayAttacher()
  for (const file of scanSpecFiles(featureDir)) {
    const source = safeRead(file)
    if (source === null) continue
    const src = parseSource(file, source).sourceFile
    const extracted = new Map(extractTestsFromSource(file, source, semanticRules).tests.map((test) => [test.line, test]))
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

    for (const { node, title, body } of playbackSourceNodes(src)) {
      const review = reviewTestBody(body, src, helperFor)
      const line = lineFor(node, src)
      const test = extracted.get(line)
      out.set(`${file}:${line}`, {
        file,
        line,
        title,
        bodySource: formatCodeForDisplay(body.getText(src)),
        helperCalls: review.helperCalls,
        helperDefinitions: review.helperDefinitions,
        externalImports: dedupe([
          ...externalImports,
          ...review.helperDefinitions.flatMap((helper) => flattenHelpers([helper]).flatMap((h) => h.externalImports)),
        ]),
        assertions: review.assertions,
        ...(test ? { extracted: withCodeDisplay(test) } : {}),
      })
    }
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
  const src = parseSource(imported.file, source).sourceFile
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
