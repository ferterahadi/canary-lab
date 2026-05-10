import fs from 'fs'
import path from 'path'
import { codeToHtml } from 'shiki'
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
  name: string
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

export interface AssertionHtmlOptions {
  videoLinksByTestName?: Record<string, string[]>
}

export interface AssertionExportAsset {
  filename: string
  data: Buffer
}

export interface AssertionExport {
  html: string
  assets: AssertionExportAsset[]
}

interface TestFlowchart {
  testName: string
  filename: string
  svg: string
}

interface TocItem {
  level: 1 | 2 | 3
  id: string
  label: string
}

interface FlowNode {
  kind: 'start' | 'setup' | 'action' | 'helper' | 'assertion' | 'end'
  title: string
  detail?: string
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

export async function createAssertionHtml(detail: RunDetail, options: AssertionHtmlOptions = {}): Promise<string> {
  const packet = buildTestReviewPacket(detail)
  const flowcharts = createFlowcharts(packet)
  return renderHtml(packet, options, flowcharts)
}

export async function createAssertionExport(detail: RunDetail, options: AssertionHtmlOptions = {}): Promise<AssertionExport> {
  const packet = buildTestReviewPacket(detail)
  const flowcharts = createFlowcharts(packet)
  return {
    html: await renderHtml(packet, options, flowcharts),
    assets: flowcharts.map((flowchart) => ({
      filename: flowchart.filename,
      data: Buffer.from(flowchart.svg, 'utf8'),
    })),
  }
}

export function buildTestReviewPacket(detail: RunDetail): TestReviewPacket {
  const events = detail.playbackEvents ?? []
  const sourceTests = loadSourceTests(detail.manifest.featureDir)
  const eventTests = playbackTests(events)
  const tests = eventTests.map((eventTest) => {
    const source = sourceTests.get(sourceKey(eventTest.location))
    return {
      name: eventTest.name,
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
      name: passedName,
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

async function renderHtml(packet: TestReviewPacket, options: AssertionHtmlOptions, flowcharts: TestFlowchart[]): Promise<string> {
  const displayFeature = titleCaseFeatureName(packet.feature)
  const testIds = uniqueSectionIds(packet.tests.map((test, idx) => `${idx + 1}-${test.title}`))
  const flowchartByTestName = new Map(flowcharts.map((flowchart) => [flowchart.testName, flowchart]))
  const implementationId = 'local-codebase-implementations'
  const tocItems: TocItem[] = [
    { level: 1, id: 'assertion-review', label: displayFeature },
    { level: 2, id: 'test-cases', label: 'Test Cases' },
    ...packet.tests.map((test, idx) => ({ level: 3 as const, id: testIds[idx], label: `${idx + 1}. ${test.title}` })),
  ]
  const externalImports = dedupe(packet.tests.flatMap((test) => test.externalImports)).sort()
  const helpers = flattenHelpers(packet.tests.flatMap((test) => test.helperDefinitions))
  if (externalImports.length || helpers.length) tocItems.push({ level: 2, id: implementationId, label: 'Local Codebase Implementations' })

  const testSections = await Promise.all(packet.tests.map(async (test, idx) => {
    const videoLinks = options.videoLinksByTestName?.[test.name] ?? []
    const flowchart = flowchartByTestName.get(test.name)
    return `
      <section class="test-case" id="${escapeAttr(testIds[idx])}">
        <h2>${idx + 1}. ${escapeHtml(test.title)}</h2>
        <dl class="case-meta">
          <div><dt>Result</dt><dd><span class="status status-${escapeAttr(statusClass(test.status))}">${escapeHtml(test.status)}</span>${typeof test.durationMs === 'number' ? ` <span class="muted">(${escapeHtml(formatMs(test.durationMs))})</span>` : ''}</dd></div>
          <div><dt>Assertion profile</dt><dd>${escapeHtml(qualitySummary(test.assertions))}</dd></div>
        </dl>
        ${flowchart ? renderFlowchartSection(flowchart, test.title) : ''}
        ${test.testBody ? `<section class="subsection test-body"><h3>Test Body</h3>${await highlightCode(test.testBody)}</section>` : ''}
        <section class="subsection"><h3>Assertions</h3><ul class="assertions">${test.assertions.map(renderAssertionHtml).join('')}</ul></section>
        ${videoLinks.length ? renderVideoSection(videoLinks) : ''}
      </section>
    `
  }))

  const implementations = await renderImplementations(externalImports, helpers, implementationId)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Assertion Review: ${escapeHtml(displayFeature)}</title>
  <style>${ASSERTION_HTML_CSS}</style>
</head>
<body>
  <div class="page-shell">
    ${renderToc(tocItems)}
    <main>
      <header class="page-header">
        <p class="eyebrow">Assertion Review</p>
        <h1 id="assertion-review">${escapeHtml(displayFeature)}</h1>
        <div class="summary-strip">
          <div><span class="summary-value">${packet.passed}/${packet.total}</span><span class="summary-label">passed</span></div>
          <div><span class="summary-value">${escapeHtml(packet.status)}</span><span class="summary-label">run status</span></div>
          <div><span class="summary-value">${packet.tests.length}</span><span class="summary-label">test cases</span></div>
        </div>
        <dl class="run-meta">
          <div><dt>Run</dt><dd><code>${escapeHtml(packet.runId)}</code></dd></div>
          <div><dt>Status</dt><dd><span class="status status-${escapeAttr(statusClass(packet.status))}">${escapeHtml(packet.status)}</span></dd></div>
          <div><dt>Result</dt><dd>${packet.passed}/${packet.total} passed</dd></div>
          <div><dt>Started</dt><dd>${escapeHtml(packet.startedAt)}</dd></div>
          ${packet.endedAt ? `<div><dt>Ended</dt><dd>${escapeHtml(packet.endedAt)}</dd></div>` : ''}
        </dl>
        <p class="scope">Local codebase helper implementations are inlined once below; external package imports are left as imports in the original source.</p>
      </header>
      <section aria-labelledby="test-cases">
        <h2 class="section-title" id="test-cases">Test Cases</h2>
        ${testSections.join('')}
      </section>
      ${implementations}
    </main>
  </div>
  <script>${ASSERTION_HTML_SCRIPT}</script>
</body>
</html>
`
}

function renderToc(items: TocItem[]): string {
  return `<nav class="toc" aria-label="Table of contents">
    <h2>Contents</h2>
    <ol>
      ${items.map((item, idx) => `<li class="toc-level-${item.level}"><a href="#${escapeAttr(item.id)}" data-section-id="${escapeAttr(item.id)}"${idx === 0 ? ' aria-current="true"' : ''}>${escapeHtml(item.label)}</a></li>`).join('')}
    </ol>
  </nav>`
}

function renderFlowchartSection(flowchart: TestFlowchart, title: string): string {
  return `<section class="subsection flow-section">
    <h3>Assertion Flow</h3>
    <figure class="flow-frame">
      <a href="${escapeAttr(flowchart.filename)}"><img src="${escapeAttr(flowchart.filename)}" alt="Assertion flow for ${escapeAttr(title)}"></a>
      <figcaption><a href="${escapeAttr(flowchart.filename)}">${escapeHtml(flowchart.filename)}</a></figcaption>
    </figure>
  </section>`
}

function renderVideoSection(videoLinks: string[]): string {
  return `<section class="subsection video-section">
    <h3>Video</h3>
    ${videoLinks.map((video) => `<figure class="video-frame"><video controls preload="metadata" src="${escapeAttr(video)}"></video><figcaption><a href="${escapeAttr(video)}">${escapeHtml(video)}</a></figcaption></figure>`).join('')}
  </section>`
}

async function renderImplementations(externalImports: string[], helpers: HelperDefinition[], id: string): Promise<string> {
  if (!externalImports.length && !helpers.length) return ''
  const source = [
    ...externalImports,
    ...helpers.map((helper) => helper.snippet),
  ].join('\n\n')
  return `<section class="implementations" id="${escapeAttr(id)}">
    <h2 class="section-title">Local Codebase Implementations</h2>
    ${await highlightCode(source)}
  </section>`
}

function createFlowcharts(packet: TestReviewPacket): TestFlowchart[] {
  const used = new Set<string>()
  return packet.tests.map((test, idx) => {
    const base = safeFilename(`${idx + 1}-${test.title}`) || `test-${idx + 1}`
    let filename = `flowcharts/${base}.svg`
    let dedupe = 2
    while (used.has(filename)) {
      filename = `flowcharts/${base}-${dedupe}.svg`
      dedupe += 1
    }
    used.add(filename)
    return {
      testName: test.name,
      filename,
      svg: renderFlowchartSvg(flowNodesForTest(test), test.title),
    }
  })
}

function flowNodesForTest(test: TestReviewCase): FlowNode[] {
  if (!test.testBody) {
    return [
      { kind: 'start', title: test.title },
      { kind: 'setup', title: 'Source unavailable', detail: qualitySummary(test.assertions) || 'No static source match' },
      { kind: 'end', title: `Result: ${test.status}` },
    ]
  }
  return [
    { kind: 'start', title: test.title },
    ...testBodyStatements(test).map((statement) => flowNodeForStatement(statement, test)),
    { kind: 'end', title: `Result: ${test.status}` },
  ]
}

function testBodyStatements(test: TestReviewCase): string[] {
  const wrapped = `async function __canaryReviewBody() ${test.testBody}`
  const src = ts.createSourceFile('assertion-flow.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fn = src.statements.find(ts.isFunctionDeclaration)
  if (!fn?.body) return test.testBody.split('\n').map((line) => cleanSnippet(line)).filter(Boolean)
  return fn.body.statements.map((statement) => cleanSnippet(statement.getText(src)))
}

function flowNodeForStatement(statement: string, test: TestReviewCase): FlowNode {
  const assertion = test.assertions.find((item) => item.snippet === statement || statement.includes(item.snippet) || item.snippet.includes(statement))
  if (assertion) {
    return { kind: 'assertion', title: `${assertion.quality} assertion`, detail: inline(assertion.snippet) }
  }
  const helper = helperForStatement(statement, test)
  if (helper) {
    const nestedCount = helper.assertions.length + helper.dependencies.reduce((count, dep) => count + flattenHelpers([dep]).reduce((sum, item) => sum + item.assertions.length, 0), 0)
    return {
      kind: 'helper',
      title: `Helper: ${helper.name}`,
      detail: nestedCount ? `${nestedCount} nested assertion${nestedCount === 1 ? '' : 's'}` : inline(statement),
    }
  }
  return {
    kind: setupLikeStatement(statement) ? 'setup' : 'action',
    title: setupLikeStatement(statement) ? 'Setup' : 'Action',
    detail: inline(statement),
  }
}

function helperForStatement(statement: string, test: TestReviewCase): HelperDefinition | undefined {
  const helperName = calledNameFromText(statement)
  if (!helperName) return undefined
  return flattenHelpers(test.helperDefinitions).find((helper) => helper.name === helperName || statement.includes(helper.name))
}

function calledNameFromText(statement: string): string | undefined {
  const match = statement.match(/(?:await\s+|return\s+)?(?:\(?\s*)?([A-Za-z_$][\w$]*)\s*\(/)
  return match?.[1]
}

function setupLikeStatement(statement: string): boolean {
  return /\b(route|mock|intercept|fixture|seed|login|storageState|setExtraHTTPHeaders|addInitScript)\b/i.test(statement)
}

function renderFlowchartSvg(nodes: FlowNode[], title: string): string {
  const width = 1280
  const nodesPerRow = 4
  const rowHeight = 150
  const rows = Math.max(1, Math.ceil(nodes.length / nodesPerRow))
  const height = 36 + rows * rowHeight
  const nodeWidth = 230
  const nodeHeight = 84
  const gap = 62
  const startX = 50
  const startY = 38
  const colors: Record<FlowNode['kind'], { fill: string; stroke: string; text: string }> = {
    start: { fill: '#f8fafc', stroke: '#64748b', text: '#334155' },
    setup: { fill: '#f8fafc', stroke: '#64748b', text: '#334155' },
    action: { fill: '#eff6ff', stroke: '#2563eb', text: '#1e3a8a' },
    helper: { fill: '#faf5ff', stroke: '#7c3aed', text: '#4c1d95' },
    assertion: { fill: '#fffbeb', stroke: '#d97706', text: '#78350f' },
    end: { fill: '#f8fafc', stroke: '#64748b', text: '#334155' },
  }
  const body = nodes.map((node, idx) => {
    const row = Math.floor(idx / nodesPerRow)
    const col = idx % nodesPerRow
    const x = startX + col * (nodeWidth + gap)
    const y = startY + row * rowHeight
    const color = node.kind === 'end' ? resultColor(node.title) : colors[node.kind]
    const titleLines = clampSvgText(node.title, 25, 2)
    const detailLines = node.detail ? clampSvgText(node.detail, 31, 2) : []
    const text = renderNodeText({ x, y, width: nodeWidth, height: nodeHeight, color: color.text, titleLines, detailLines })
    const next = idx < nodes.length - 1 ? {
      row: Math.floor((idx + 1) / nodesPerRow),
      col: (idx + 1) % nodesPerRow,
    } : null
    const arrow = next
      ? next.row === row
        ? `<path class="connector" d="M${x + nodeWidth + 10} ${y + nodeHeight / 2} L${x + nodeWidth + gap - 12} ${y + nodeHeight / 2}" marker-end="url(#arrow)" />`
        : `<path class="connector" d="M${x + nodeWidth / 2} ${y + nodeHeight + 10} C${x + nodeWidth / 2} ${y + 124}, ${startX + nodeWidth / 2} ${startY + next.row * rowHeight - 22}, ${startX + nodeWidth / 2} ${startY + next.row * rowHeight - 8}" marker-end="url(#arrow)" />`
      : ''
    return `<g>
      ${nodeShape(node.kind, x, y, nodeWidth, nodeHeight, color.fill, color.stroke)}
      ${text}
      ${arrow}
    </g>`
  }).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Assertion flow for ${escapeAttr(title)}">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L7,3 z" fill="#64748b" />
    </marker>
    <filter id="nodeShadow" x="-10%" y="-20%" width="120%" height="150%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#0f172a" flood-opacity="0.10" />
    </filter>
  </defs>
  <rect width="100%" height="100%" rx="14" fill="#ffffff" />
  <style>.connector{fill:none;stroke:#64748b;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}</style>
  <style>text{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}</style>
  ${body}
</svg>
`
}

function renderNodeText(args: {
  x: number
  y: number
  width: number
  height: number
  color: string
  titleLines: string[]
  detailLines: string[]
}): string {
  const titleSize = 14
  const detailSize = 11
  const titleGap = 16
  const detailGap = 14
  const blockGap = args.titleLines.length && args.detailLines.length ? 8 : 0
  const blockHeight =
    (args.titleLines.length * titleGap) +
    blockGap +
    (args.detailLines.length * detailGap)
  let cursor = args.y + (args.height - blockHeight) / 2 + 12
  const title = args.titleLines.map((line) => {
    const out = `<text x="${args.x + args.width / 2}" y="${cursor}" text-anchor="middle" font-size="${titleSize}" font-weight="800" fill="${args.color}">${escapeHtml(line)}</text>`
    cursor += titleGap
    return out
  })
  if (blockGap) cursor += blockGap
  const detail = args.detailLines.map((line) => {
    const out = `<text x="${args.x + args.width / 2}" y="${cursor}" text-anchor="middle" font-size="${detailSize}" fill="#475569">${escapeHtml(line)}</text>`
    cursor += detailGap
    return out
  })
  return [...title, ...detail].join('')
}

function resultColor(title: string): { fill: string; stroke: string; text: string } {
  const normalized = title.toLowerCase()
  if (normalized.includes('passed') || normalized.includes('succeed') || normalized.includes('success')) {
    return { fill: '#ecfdf5', stroke: '#16a34a', text: '#14532d' }
  }
  if (normalized.includes('failed') || normalized.includes('fail')) {
    return { fill: '#fff1f2', stroke: '#e11d48', text: '#881337' }
  }
  return { fill: '#f8fafc', stroke: '#64748b', text: '#334155' }
}

function nodeShape(kind: FlowNode['kind'], x: number, y: number, width: number, height: number, fill: string, stroke: string): string {
  if (kind === 'assertion') {
    const points = [
      `${x + 18},${y}`,
      `${x + width - 18},${y}`,
      `${x + width},${y + height / 2}`,
      `${x + width - 18},${y + height}`,
      `${x + 18},${y + height}`,
      `${x},${y + height / 2}`,
    ].join(' ')
    return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#nodeShadow)" />`
  }
  if (kind === 'start' || kind === 'end') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#nodeShadow)" />`
  }
  if (kind === 'setup') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="6 5" filter="url(#nodeShadow)" />`
  }
  if (kind === 'helper') {
    return `<path d="M${x} ${y + 10} Q${x} ${y} ${x + 10} ${y} H${x + width - 10} Q${x + width} ${y} ${x + width} ${y + 10} V${y + height - 10} Q${x + width} ${y + height} ${x + width - 10} ${y + height} H${x + 10} Q${x} ${y + height} ${x} ${y + height - 10} Z M${x + 12} ${y} V${y + height}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#nodeShadow)" />`
  }
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#nodeShadow)" />`
}

function wrapSvgText(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').flatMap((word) => splitLongWord(word, maxChars)).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

function clampSvgText(text: string, maxChars: number, maxLines: number): string[] {
  const lines = wrapSvgText(text, maxChars)
  if (lines.length <= maxLines) return lines
  const out = lines.slice(0, maxLines)
  out[maxLines - 1] = `${out[maxLines - 1].slice(0, Math.max(0, maxChars - 1)).replace(/\s+$/g, '')}…`
  return out
}

function splitLongWord(word: string, maxChars: number): string[] {
  if (word.length <= maxChars) return [word]
  const parts: string[] = []
  for (let idx = 0; idx < word.length; idx += maxChars) parts.push(word.slice(idx, idx + maxChars))
  return parts
}

function renderAssertionHtml(assertion: TestReviewAssertion): string {
  const nested = (assertion.nested ?? [])
    .map((item) => `<li>nested ${escapeHtml(item.quality)}: <code>${escapeHtml(inline(item.snippet))}</code></li>`)
    .join('')
  return `<li>
    <div><span class="quality quality-${escapeAttr(assertion.quality)}">${escapeHtml(assertion.quality)}</span> ${escapeHtml(assertion.rationale)}</div>
    <code>${escapeHtml(inline(assertion.snippet))}</code>
    ${assertion.helperSnippet ? `<div class="helper-ref">helper: <code>${escapeHtml(assertion.helperName ?? '')}</code></div>` : ''}
    ${nested ? `<ul>${nested}</ul>` : ''}
  </li>`
}

async function highlightCode(source: string): Promise<string> {
  try {
    return await codeToHtml(source, { lang: 'typescript', theme: 'one-light' })
  } catch {
    return `<pre class="fallback-code"><code>${escapeHtml(source)}</code></pre>`
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;')
}

function statusClass(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'unknown'
}

const ASSERTION_HTML_CSS = `
:root {
  color-scheme: light;
  --bg: #f7f8fb;
  --surface: #ffffff;
  --surface-muted: #f8fafc;
  --border: #d9e0ea;
  --border-strong: #b9c4d4;
  --text: #111827;
  --muted: #64748b;
  --accent: #0f766e;
  --danger: #b42318;
  --ok: #16794c;
  --warn: #a16207;
  --code-border: #d7dde7;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
main {
  min-width: 0;
  padding: 28px 0 48px;
}
.page-shell {
  display: grid;
  grid-template-columns: 232px minmax(0, 1180px);
  gap: 22px;
  width: min(1450px, calc(100vw - 28px));
  margin: 0 auto;
}
h1, h2, h3, p { margin-top: 0; }
.page-header, .test-case, .implementations {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);
}
.page-header { padding: 24px; margin-bottom: 18px; }
.implementations { padding: 18px; margin-top: 14px; }
.toc {
  position: sticky;
  top: 14px;
  align-self: start;
  max-height: calc(100vh - 28px);
  overflow: auto;
  padding: 14px;
  margin-top: 28px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);
}
.toc h2 { margin-bottom: 10px; font-size: 11px; color: var(--text); font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 3px 0; }
.toc a {
  display: block;
  color: var(--muted);
  text-decoration: none;
  overflow-wrap: anywhere;
  border-radius: 6px;
  padding: 6px 8px;
  border-left: 3px solid transparent;
  font-weight: 600;
}
.toc a:hover { color: var(--text); background: var(--surface-muted); }
.toc a[aria-current="true"] {
  color: var(--accent);
  background: #ecfdf5;
  border-left-color: var(--accent);
  font-weight: 700;
}
.toc-level-1 a { color: var(--text); font-size: 15px; font-weight: 850; line-height: 1.35; }
.toc-level-2 { padding-left: 6px; margin-top: 10px !important; }
.toc-level-2 a { color: var(--text); font-size: 14px; font-weight: 850; line-height: 1.3; }
.toc-level-3 { padding-left: 14px; font-size: 11px; }
.toc-level-3 a { padding: 4px 8px; font-size: 11px; font-weight: 650; line-height: 1.35; }
.eyebrow {
  margin-bottom: 4px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1 { font-size: 28px; line-height: 1.15; margin-bottom: 16px; }
.summary-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.summary-strip div {
  padding: 10px 12px;
  background: linear-gradient(180deg, #ffffff, #f8fafc);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.summary-value { display: block; font-size: 18px; line-height: 1.15; font-weight: 800; color: var(--text); }
.summary-label { display: block; margin-top: 2px; font-size: 10px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.section-title { font-size: 18px; margin: 20px 0 10px; }
.test-case { padding: 18px; margin-bottom: 14px; }
.test-case > h2 { font-size: 17px; margin-bottom: 10px; }
.subsection { margin-top: 14px; }
.subsection h3 { font-size: 12px; margin-bottom: 7px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.run-meta, .case-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  margin: 0;
}
.run-meta div, .case-meta div {
  min-width: 0;
  padding: 8px 10px;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
}
dt { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.scope { margin: 18px 0 0; color: var(--muted); }
.muted { color: var(--muted); }
.status, .quality {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 700;
  border: 1px solid currentColor;
}
.status-passed, .quality-strict { color: var(--ok); background: #e8f7ef; }
.status-failed, .quality-unknown { color: var(--danger); background: #fff0ee; }
.status-aborted, .quality-shallow { color: var(--warn); background: #fff8e6; }
.quality-moderate { color: #1d4ed8; background: #eff6ff; }
.flow-frame { margin: 0; }
.flow-frame img {
  display: block;
  width: 100%;
  max-height: 340px;
  object-fit: contain;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.video-frame { margin: 0 0 14px; }
video {
  display: block;
  width: 100%;
  max-height: 520px;
  background: #020617;
  border: 1px solid var(--border);
  border-radius: 8px;
}
figcaption { margin-top: 6px; font-size: 12px; }
a { color: var(--accent); }
.assertions { padding-left: 20px; }
.assertions li { margin: 8px 0; }
.assertions code, dd code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 4px;
}
.helper-ref { margin-top: 4px; color: var(--muted); }
.shiki, .fallback-code {
  border: 1px solid var(--code-border);
  border-radius: 7px;
  overflow: auto;
  padding: 10px !important;
  margin: 0 !important;
  font-size: 12px;
  line-height: 1.55;
}
.shiki code, .fallback-code code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
@media (max-width: 900px) {
  .page-shell { display: block; width: min(100vw - 20px, 1120px); }
  main { padding-top: 18px; }
  .toc { position: static; max-height: none; margin: 18px 0 0; }
  .summary-strip { grid-template-columns: 1fr; }
  .page-header, .test-case { padding: 16px; }
  h1 { font-size: 24px; }
}
`

const ASSERTION_HTML_SCRIPT = `
(() => {
  const links = [...document.querySelectorAll('.toc a[data-section-id]')]
  const sections = links
    .map((link) => document.getElementById(link.dataset.sectionId))
    .filter(Boolean)
  if (!links.length || !sections.length || !('IntersectionObserver' in window)) return
  const setActive = (id) => {
    for (const link of links) {
      const active = link.dataset.sectionId === id
      if (active) link.setAttribute('aria-current', 'true')
      else link.removeAttribute('aria-current')
    }
  }
  const visible = new Map()
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top)
      else visible.delete(entry.target.id)
    }
    const active = [...visible.entries()].sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0]
    if (active) setActive(active[0])
  }, { rootMargin: '-20% 0px -65% 0px', threshold: [0, 0.1, 0.5] })
  for (const section of sections) observer.observe(section)
  if (location.hash) setActive(location.hash.slice(1))
})()
`

function playbackTests(events: PlaywrightPlaybackEvent[]): Array<{
  name: string
  title: string
  location: string
  status: string
  durationMs?: number
}> {
  return events
    .filter((event): event is Extract<PlaywrightPlaybackEvent, { type: 'test-end' }> => event.type === 'test-end')
    .map((event) => ({
      name: event.test.name,
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

function uniqueSectionIds(values: string[]): string[] {
  const used = new Set<string>()
  return values.map((value) => {
    const base = safeFilename(value)
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`
      suffix += 1
    }
    used.add(candidate)
    return candidate
  })
}

function safeFilename(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

function titleCaseFeatureName(input: string): string {
  return input
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-zA-Z]/g, (char) => char.toUpperCase())
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
