import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import type { RunDetail, PlaywrightPlaybackEvent } from './run-store'

export type AssertionQuality = 'strict' | 'moderate' | 'shallow' | 'unknown'

export interface TestReviewAssertion {
  kind: 'direct' | 'helper'
  label: string
  quality: AssertionQuality
  rationale: string
  snippet: string
  helperName?: string
  helperSnippet?: string
  nested?: TestReviewAssertion[]
}

export interface TestReviewCase {
  title: string
  status: string
  durationMs?: number
  testBody: string
  helperCalls: string[]
  helperDefinitions: HelperDefinition[]
  externalImports: string[]
  assertions: TestReviewAssertion[]
}

export interface TestReviewPacket {
  runId: string
  feature: string
  status: string
  total: number
  passed: number
  failed: number
  startedAt: string
  endedAt?: string
  tests: TestReviewCase[]
}

interface SourceTest {
  file: string
  line: number
  title: string
  bodySource: string
  helperCalls: string[]
  helperDefinitions: HelperDefinition[]
  externalImports: string[]
  assertions: TestReviewAssertion[]
}

interface ImportedHelper {
  name: string
  file: string
}

export interface HelperDefinition {
  name: string
  file: string
  snippet: string
  externalImports: string[]
  dependencies: HelperDefinition[]
  assertions: TestReviewAssertion[]
}

export function createAssertionMarkdown(detail: RunDetail): string {
  const packet = buildTestReviewPacket(detail)
  return renderMarkdown(packet)
}

export function buildTestReviewPacket(detail: RunDetail): TestReviewPacket {
  const events = detail.playbackEvents ?? []
  const sourceTests = loadSourceTests(detail.manifest.featureDir)
  const eventTests = playbackTests(events)
  const tests = eventTests.map((eventTest) => {
    const source = sourceTests.get(sourceKey(eventTest.location))
    return {
      title: eventTest.title,
      status: eventTest.status,
      ...(typeof eventTest.durationMs === 'number' ? { durationMs: eventTest.durationMs } : {}),
      testBody: source?.bodySource ?? '',
      helperCalls: source?.helperCalls ?? [],
      helperDefinitions: source?.helperDefinitions ?? [],
      externalImports: source?.externalImports ?? [],
      assertions: source?.assertions.length
        ? source.assertions
        : [unknownAssertion('No static assertion detected in the matched test body.')],
    }
  })

  for (const passedName of detail.summary?.passedNames ?? []) {
    if (tests.some((test) => slugFromTitle(test.title) === passedName || test.title === passedName)) continue
    tests.push({
      title: passedName,
      status: 'passed',
      testBody: '',
      helperCalls: [],
      helperDefinitions: [],
      externalImports: [],
      assertions: [unknownAssertion('No playback event or source match was available for this passed test.')],
    })
  }

  return {
    runId: detail.runId,
    feature: detail.manifest.feature,
    status: detail.manifest.status,
    total: detail.summary?.total ?? tests.length,
    passed: detail.summary?.passed ?? tests.filter((test) => test.status === 'passed').length,
    failed: detail.summary?.failed?.length ?? tests.filter((test) => test.status !== 'passed').length,
    startedAt: detail.manifest.startedAt,
    ...(detail.manifest.endedAt ? { endedAt: detail.manifest.endedAt } : {}),
    tests,
  }
}

function loadSourceTests(featureDir: string | undefined): Map<string, SourceTest> {
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
            bodySource: cleanSnippet(body.getText(src)),
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

function readRelativeImports(file: string, src: ts.SourceFile): Map<string, ImportedHelper> {
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

function readExternalImports(src: ts.SourceFile): string[] {
  const imports: string[] = []
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text.startsWith('.')) continue
    imports.push(cleanSnippet(stmt.getText(src)))
  }
  return imports
}

function readHelperDefinition(imported: ImportedHelper, seen: Set<string>): HelperDefinition | undefined {
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
      externalImports,
      dependencies,
      assertions: body ? collectDirectAssertions(body, src) : [],
    }
  }

  visit(src)
  return found
}

function reviewTestBody(
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
        if (name && !isPlaywrightTestCall(node) && !isNoiseHelper(name)) {
          helperCalls.push(cleanSnippet(node.getText(src)))
          const helper = helperFor(name)
          if (helper) helperDefinitions.push(helper)
        }
        if (name?.startsWith('expect')) {
          const helper = helperFor(name)
          assertions.push(helperAssertion(node, src, helper))
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

function collectDirectAssertions(body: ts.Node, src: ts.SourceFile): TestReviewAssertion[] {
  const assertions: TestReviewAssertion[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && (isAssertionCall(node) || isWaitAssertionCall(node))) assertions.push(assertionFor(node, src, 'direct'))
    node.forEachChild(visit)
  }
  visit(body)
  return dedupeAssertions(assertions)
}

function collectLocalDependencies(
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

function hasLocalDefinition(src: ts.SourceFile, name: string): boolean {
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

function helperAssertion(
  node: ts.CallExpression,
  src: ts.SourceFile,
  helper: HelperDefinition | undefined,
): TestReviewAssertion {
  const label = calledIdentifier(node)!
  const nested = helper?.assertions ?? []
  const quality = nested.length ? strongestQuality(nested) : 'unknown'
  return {
    kind: 'helper',
    label,
    quality,
    rationale: nested.length
      ? `Helper resolves to ${nested.length} nested assertion${nested.length === 1 ? '' : 's'}; label reflects the strongest nested check.`
      : 'Helper implementation could not be resolved statically, so strictness is unknown.',
    snippet: cleanSnippet(node.getText(src)),
    helperName: label,
    ...(helper?.snippet ? { helperSnippet: helper.snippet } : {}),
    ...(nested.length ? { nested } : {}),
  }
}

function assertionFor(
  node: ts.CallExpression,
  src: ts.SourceFile,
  kind: TestReviewAssertion['kind'],
): TestReviewAssertion {
  const snippet = cleanSnippet(node.getText(src))
  const matcher = matcherName(node)
  const quality = classifyAssertion(snippet, matcher)
  return {
    kind,
    label: matcher!,
    quality,
    rationale: rationaleFor(quality, snippet, matcher),
    snippet,
  }
}

function classifyAssertion(snippet: string, matcher?: string): AssertionQuality {
  const text = snippet.toLowerCase()
  const strictMatchers = new Set([
    'tohavetext',
    'tocontaintext',
    'tohaveurl',
    'tohavevalue',
    'tohaveattribute',
    'tohavecount',
    'tobechecked',
    'tobedisabled',
    'tobeenabled',
    'waitforurl',
    'toequal',
    'tostrictEqual'.toLowerCase(),
    'tobe',
  ])
  if (matcher && strictMatchers.has(matcher.toLowerCase())) return 'strict'
  if (/thank|success|error|expired|redeemed|not\s+found|cannot|reject|order|voucher|url|toast/.test(text)) return 'strict'
  if (matcher && ['tobevisible', 'tobehidden', 'toBeAttached'.toLowerCase()].includes(matcher.toLowerCase())) return 'moderate'
  if (/visible|hidden|attached|enabled|disabled/.test(text)) return 'moderate'
  if (/count|length|exist|present/.test(text)) return 'shallow'
  return 'unknown'
}

function rationaleFor(quality: AssertionQuality, snippet: string, matcher?: string): string {
  if (quality === 'strict') {
    return `Uses ${matcher} against concrete expected behavior or copy.`
  }
  if (quality === 'moderate') return 'Checks a meaningful UI condition, but the static evidence is indirect.'
  if (quality === 'shallow') return 'Checks weak existence or quantity evidence without proving the business outcome.'
  return 'Static analysis could not confidently classify this assertion.'
}

function renderMarkdown(packet: TestReviewPacket): string {
  const lines = [
    `# Assertion Review: ${packet.feature}`,
    ``,
    `- Run: ${packet.runId}`,
    `- Status: ${packet.status}`,
    `- Result: ${packet.passed}/${packet.total} passed`,
    `- Scope: local codebase helper implementations are inlined once below; external package imports are left as imports in the original source.`,
    ``,
  ]

  lines.push(`## Test Cases`)
  lines.push('')

  packet.tests.forEach((test, idx) => {
    lines.push(`### ${idx + 1}. ${test.title}`)
    lines.push('')
    lines.push(`- Result: ${test.status}${typeof test.durationMs === 'number' ? ` (${formatMs(test.durationMs)})` : ''}`)
    lines.push(`- Assertion profile: ${qualitySummary(test.assertions)}`)
    lines.push('')
    if (test.testBody) {
      lines.push(`### Test Body`)
      lines.push('')
      lines.push('```ts')
      lines.push(test.testBody)
      lines.push('```')
      lines.push('')
    }
    if (test.helperCalls.length) {
      lines.push(`### Helper Calls`)
      lines.push('')
      for (const call of test.helperCalls) lines.push(`- \`${inline(call)}\``)
      lines.push('')
    }
    lines.push(`#### Assertions`)
    lines.push('')
    for (const assertion of test.assertions) renderAssertion(lines, assertion)
    lines.push('')
  })

  const externalImports = dedupe(packet.tests.flatMap((test) => test.externalImports)).sort()
  const helpers = flattenHelpers(packet.tests.flatMap((test) => test.helperDefinitions))
  if (externalImports.length || helpers.length) {
    lines.push(`## Local Codebase Implementations`)
    lines.push('')
    if (externalImports.length) {
      lines.push(`External imports preserved from the original files:`)
      lines.push('')
      lines.push('```ts')
      lines.push(...externalImports)
      lines.push('```')
      lines.push('')
    }
    for (const helper of helpers) {
      lines.push(`### ${helper.name}`)
      lines.push('')
      lines.push('```ts')
      lines.push(helper.snippet)
      lines.push('```')
      lines.push('')
    }
  }

  return `${lines.join('\n')}\n`
}

function renderAssertion(lines: string[], assertion: TestReviewAssertion): void {
  lines.push(`- ${assertion.quality}: ${assertion.rationale}`)
  lines.push(`  - \`${inline(assertion.snippet)}\``)
  if (assertion.helperSnippet) {
    lines.push(`  - helper: \`${assertion.helperName}\``)
  }
  for (const nested of assertion.nested ?? []) {
    lines.push(`  - nested ${nested.quality}: \`${inline(nested.snippet)}\``)
  }
}

function playbackTests(events: PlaywrightPlaybackEvent[]): Array<{
  title: string
  location: string
  status: string
  durationMs?: number
}> {
  return events
    .filter((event): event is Extract<PlaywrightPlaybackEvent, { type: 'test-end' }> => event.type === 'test-end')
    .map((event) => ({
      title: event.test.title,
      location: event.test.location,
      status: event.status,
      durationMs: event.durationMs,
    }))
}

function listSpecFiles(featureDir: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (/\.(?:spec|test)\.[tj]sx?$/.test(entry.name)) out.push(full)
    }
  }
  visit(featureDir)
  return out.sort()
}

function sourceKey(location: string): string {
  const match = location.match(/^(.*):(\d+)(?::\d+)?$/)
  return match ? `${match[1]}:${match[2]}` : location
}

function isPlaywrightTestCall(node: ts.CallExpression): boolean {
  const chain = calleeChain(node.expression)
  if (chain[0] !== 'test') return false
  if (chain[1] === 'describe' || chain[1] === 'step') return false
  return chain.length >= 1
}

function isAssertionCall(node: ts.CallExpression): boolean {
  const chain = calleeChain(node.expression)
  const idx = chain.lastIndexOf('expect')
  return idx >= 0 && idx < chain.length - 1
}

function isWaitAssertionCall(node: ts.CallExpression): boolean {
  return matcherName(node)?.toLowerCase() === 'waitforurl'
}

function matcherName(node: ts.CallExpression): string | undefined {
  const chain = calleeChain(node.expression)
  const idx = chain.lastIndexOf('expect')
  if (idx >= 0 && idx < chain.length - 1) return chain[chain.length - 1]
  const last = chain.at(-1)
  return last?.startsWith('waitFor') ? last : undefined
}

function calleeChain(expr: ts.Expression): string[] {
  if (ts.isIdentifier(expr)) return [expr.text]
  if (ts.isPropertyAccessExpression(expr)) return [...calleeChain(expr.expression), expr.name.text]
  if (ts.isCallExpression(expr)) return calleeChain(expr.expression)
  return []
}

function calledIdentifier(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  return undefined
}

function stringArg(node: ts.CallExpression, src: ts.SourceFile): string | undefined {
  const arg = node.arguments[0]
  if (!arg) return undefined
  if (ts.isStringLiteralLike(arg)) return arg.text
  if (ts.isTemplateExpression(arg)) return arg.getText(src).slice(1, -1)
  return undefined
}

function functionBody(node: ts.CallExpression): ts.ConciseBody | undefined {
  const fn = node.arguments[1]
  if (!fn) return undefined
  return ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? fn.body : undefined
}

function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name?.text
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0]
    if (decl && ts.isIdentifier(decl.name)) return decl.name.text
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
  return undefined
}

function functionLikeBody(node: ts.Node): ts.ConciseBody | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node.body
  if (ts.isVariableStatement(node)) {
    const init = node.declarationList.declarations[0]?.initializer
    return init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) ? init.body : undefined
  }
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer
    return init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) ? init.body : undefined
  }
  return undefined
}

function lineFor(node: ts.Node, src: ts.SourceFile): number {
  return src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
}

function resolveImport(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

function cleanSnippet(input: string): string {
  return input.replace(/\r\n/g, '\n').trim()
}

function inline(input: string): string {
  return input.replace(/\s+/g, ' ').replace(/`/g, '\\`').slice(0, 220)
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function dedupeAssertions(assertions: TestReviewAssertion[]): TestReviewAssertion[] {
  const seen = new Set<string>()
  return assertions.filter((assertion) => {
    const key = `${assertion.kind}:${assertion.snippet}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeHelpers(helpers: HelperDefinition[]): HelperDefinition[] {
  const seen = new Set<string>()
  return helpers.filter((helper) => {
    const key = `${helper.file}:${helper.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function flattenHelpers(helpers: HelperDefinition[]): HelperDefinition[] {
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

function strongestQuality(assertions: TestReviewAssertion[]): AssertionQuality {
  const rank: Record<AssertionQuality, number> = { unknown: 0, shallow: 1, moderate: 2, strict: 3 }
  return assertions.reduce<AssertionQuality>((best, assertion) =>
    rank[assertion.quality] > rank[best] ? assertion.quality : best, 'unknown')
}

function qualitySummary(assertions: TestReviewAssertion[]): string {
  const counts = new Map<AssertionQuality, number>()
  for (const assertion of assertions) counts.set(assertion.quality, (counts.get(assertion.quality) ?? 0) + 1)
  return (['strict', 'moderate', 'shallow', 'unknown'] as const)
    .flatMap((quality) => counts.has(quality) ? [`${counts.get(quality)} ${quality}`] : [])
    .join(', ')
}

function unknownAssertion(rationale: string): TestReviewAssertion {
  return {
    kind: 'direct',
    label: 'unknown',
    quality: 'unknown',
    rationale,
    snippet: '',
  }
}

function isNoiseHelper(name: string): boolean {
  return ['test', 'describe', 'beforeEach', 'afterEach'].includes(name)
}

function slugFromTitle(title: string): string {
  return `test-case-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
