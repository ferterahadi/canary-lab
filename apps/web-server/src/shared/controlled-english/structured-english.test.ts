import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { ReadableEnglishBlock, ReadableSemanticRuleConfig } from '../../../../../shared/readable-tests/types'
import { compileSemanticSource } from './semantic-context'
import {
  composeCatchHeader,
  composeFinallyHeader,
  composeIfHeader,
  composeIfPath,
  composeLoopHeader,
  composeStatementEnglish,
  composeSwitchHeader,
  composeSwitchPath,
  composeTryHeader,
  renderEnglishSpans,
} from './structured-english'

function functionBlocks(
  source: string,
  semanticRules?: ReadableSemanticRuleConfig,
): { blocks: ReadableEnglishBlock[]; sourceFile: ts.SourceFile } {
  const context = compileSemanticSource('/workspace/scenario.ts', source, {
    semanticRules,
    absoluteSourceRanges: true,
  })
  const fn = context.sourceFile.statements.find(ts.isFunctionDeclaration)
  if (!fn?.body) throw new Error('Expected scenario function')
  return {
    blocks: fn.body.statements.map((statement) => {
      const english = composeStatementEnglish(statement, context)
      if (!english) throw new Error(`No structured English for ${ts.SyntaxKind[statement.kind]}`)
      return english
    }),
    sourceFile: context.sourceFile,
  }
}

function playwrightBlocks(body: string): ReadableEnglishBlock[] {
  const source = `import { expect, test } from '@playwright/test'
test('scenario', async ({ request }) => {
${body}
})`
  const context = compileSemanticSource('/workspace/scenario.spec.ts', source)
  let callback: ts.ArrowFunction | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node)) callback = node
    else node.forEachChild(visit)
  }
  visit(context.sourceFile)
  if (!callback || !ts.isBlock(callback.body)) throw new Error('Expected Playwright callback')
  return callback.body.statements.map((statement) => {
    const english = composeStatementEnglish(statement, context)
    if (!english) throw new Error(`No structured English for ${ts.SyntaxKind[statement.kind]}`)
    return english
  })
}

describe('structured controlled English', () => {
  it('renders the requested request/assertion example as complete natural compositions', () => {
    const blocks = playwrightBlocks(`  const res = await request.get(\`${'${GATEWAY_URL}'}/\`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.status).toBe("OK")`)

    expect(blocks.map((item) => item.text)).toEqual([
      'Await `request.get(`${GATEWAY_URL}/`)` and store the result in constant `res`.',
      'Check that `res.status` equals `200`.',
      'Await `res.json()` and store the result in constant `body`.',
      'Check that `body.status` equals `"OK"`.',
    ])
    expect(blocks[0].spans.find((span) => span.kind === 'code')?.semanticCategories).toEqual([
      'external-api',
      'function-call',
    ])
    expect(blocks[1].semanticCategories).toEqual(['assertion'])
    expect(blocks[2].semanticCategories).toEqual(['declaration', 'async', 'function-call'])
  })

  it('keeps nested assertion, async, and external API metadata on separate spans', () => {
    const { blocks } = functionBlocks(`async function scenario() {
  expect(await fetch('/users/1')).toBeDefined()
}`)
    expect(blocks[0].text).toBe("Check that `await fetch('/users/1')` is defined.")
    expect(blocks[0].spans).toEqual([
      expect.objectContaining({ text: 'Check that ', semanticCategories: ['assertion'] }),
      expect.objectContaining({
        text: "await fetch('/users/1')",
        kind: 'code',
        semanticCategories: ['external-api', 'async', 'function-call'],
      }),
      expect.objectContaining({ text: ' is defined', semanticCategories: ['assertion'] }),
      expect.objectContaining({ text: '.', semanticCategories: ['assertion'] }),
    ])
  })

  it('classifies database calls from import and Symbol provenance, never method names alone', () => {
    const { blocks } = functionBlocks(`import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function scenario() {
  await prisma.user.findMany()
  await foo.findMany()
}`)
    expect(blocks[0].semanticCategories).toEqual(['database', 'async', 'function-call'])
    expect(blocks[1].semanticCategories).toEqual(['async', 'function-call'])
    expect(blocks[1].semanticCategories).not.toContain('database')
  })

  it('extends API recognition through module configuration without changing the AST renderer', () => {
    const { blocks } = functionBlocks(`import client from '@company/api-client'
async function scenario() {
  await client.send(payload)
}`, { apiClients: ['@company/api-client'] })
    expect(blocks[0].semanticCategories).toEqual(['external-api', 'async', 'function-call'])
  })

  it('does not invent meaning for an unregistered assertion matcher', () => {
    const { blocks } = functionBlocks(`function scenario() {
  expect(order).toSatisfyBusinessRule(rule)
}`)
    expect(blocks[0].text).toBe('Call `expect(order).toSatisfyBusinessRule(rule)`.')
    expect(blocks[0].semanticCategories).toEqual(['assertion', 'function-call'])
  })

  it('uses Symbol evidence to recognize an aliased assertion import', () => {
    const { blocks } = functionBlocks(`import { expect as verify } from 'vitest'
function scenario() {
  verify(value).toBe(expected)
}`)
    expect(blocks[0].text).toBe('Check that `value` equals `expected`.')
    expect(blocks[0].semanticCategories).toEqual(['assertion'])
  })

  it('recognizes assertions re-exported by the Canary Lab log-marker fixture', () => {
    const { blocks } = functionBlocks(`import { expect } from 'canary-lab/feature-support/log-marker-fixture'
function scenario() {
  expect(isCleanExit(exit)).toBe(true)
  expect(elapsedMs).toBeLessThan(IDLE_EXIT_BUDGET_MS)
  expect(consumer.logs()).toContain(DRAIN_COMPLETE_MARKER)
}`)
    expect(blocks.map((item) => item.text)).toEqual([
      'Check that `isCleanExit(exit)` equals `true`.',
      'Check that `elapsedMs` is less than `IDLE_EXIT_BUDGET_MS`.',
      'Check that `consumer.logs()` contains `DRAIN_COMPLETE_MARKER`.',
    ])
    expect(blocks.every((item) => item.semanticCategories.includes('assertion'))).toBe(true)
  })

  it('renders an expression-bodied callback as structure without inventing map intent', () => {
    const { blocks } = functionBlocks(`function scenario() {
  items.map(item => item.id)
}`)
    expect(blocks[0].text).toBe(
      'Call `items.map` with an arrow function that:\n    Returns `item.id`.',
    )
    expect(blocks[0].text).not.toContain('Extract')
  })

  it('retains exact source offsets on blocks and code spans', () => {
    const source = `function scenario() {
  return user.profile.name
}`
    const { blocks, sourceFile } = functionBlocks(source)
    const codeSpan = blocks[0].spans.find((span) => span.kind === 'code')
    expect(codeSpan?.sourceRange).toBeDefined()
    expect(sourceFile.text.slice(codeSpan!.sourceRange!.start, codeSpan!.sourceRange!.end))
      .toBe('user.profile.name')
    expect(sourceFile.text.slice(blocks[0].sourceRange!.start, blocks[0].sourceRange!.end))
      .toBe('return user.profile.name')
    expect(blocks[0].spans.every((span) => span.sourceRange)).toBe(true)
  })

  it('covers declaration, assignment, return, throw, await, and fallback compositions', () => {
    const { blocks } = functionBlocks(`async function scenario() {
  const declared: Result
  const loaded = load()
  let value = initial
  var legacy = 1
  left = right
  total += amount
  await pending
  await new Service()
  return
  return value
  throw error
}`)
    expect(blocks.map((item) => item.text)).toEqual([
      'Declare constant `declared` with type `Result`.',
      'Call `load()` and store the result in constant `loaded`.',
      'Store `initial` in variable `value`.',
      'Store `1` in legacy variable `legacy`.',
      'Set `left` to `right`.',
      'Add and assign to `total` using `amount`.',
      'Await `pending`.',
      'Await `new Service()`.',
      'Return.',
      'Return `value`.',
      'Throw `error`.',
    ])
  })

  it('declines unsafe or non-compositional statements so exhaustive syntax remains the fallback', () => {
    const context = compileSemanticSource('/workspace/fallback.ts', `function scenario() {
  const a = 1, b = 2
  left + right
  debugger
}`)
    const fn = context.sourceFile.statements.find(ts.isFunctionDeclaration)!
    expect(fn.body?.statements.map((statement) => composeStatementEnglish(statement, context)))
      .toEqual([undefined, undefined, undefined])
  })

  it('handles awaited, soft, negated, bracketed, incomplete, and unknown assertion forms conservatively', () => {
    const context = compileSemanticSource('/workspace/assertions.ts', `async function scenario() {
  await expect.soft(value).not.toEqual(expected)
  expect(value)['toBe'](1)
  expect().toBe(1)
  expect(value).toBe()
  expect(value).custom(expected)
  other(value).toBe(expected)
  expect.poll(read)().toBe(value)
  expect.toBe(value)
  expect[matcher](value)
}`)
    const fn = context.sourceFile.statements.find(ts.isFunctionDeclaration)!
    const blocks = fn.body!.statements.map((statement) => composeStatementEnglish(statement, context))
    expect(blocks.map((item) => item?.text)).toEqual([
      'Await the check that `value` does not deeply equal `expected`.',
      'Check that `value` equals `1`.',
      'Call `expect().toBe(1)`.',
      'Call `expect(value).toBe()`.',
      'Call `expect(value).custom(expected)`.',
      'Call `other(value).toBe(expected)`.',
      'Call `expect.poll(read)().toBe(value)`.',
      'Call `expect.toBe(value)`.',
      'Call `expect[matcher](value)`.',
    ])
  })

  it('renders normal and awaited callbacks while block callbacks stay exact as calls', () => {
    const { blocks } = functionBlocks(`async function scenario() {
  await items.map(item => item.id)
  items.map(item => { return item.id })
  call(first, second)
}`)
    expect(blocks.map((item) => item.text)).toEqual([
      'Await a call to `items.map` with an arrow function that:\n    Returns `item.id`.',
      'Call `items.map(item => { return item.id })`.',
      'Call `call(first, second)`.',
    ])
  })

  it('renders all structured control-flow headers with and without absolute ranges', () => {
    const source = `async function scenario() {
  if (status === 200) { return body } else { throw error }
  if (ready) run()
  if (left = right) run()
  switch (state) { case 'ready': run(); break; default: stop() }
  try { run() } catch (error) { throw error } finally { cleanup() }
  try { run() } catch { recover() }
  for (let i = 0; i < 2; i += 1) run(i)
  for (;;) stop()
  for (const item of items) run(item)
  for await (const event of stream) run(event)
  for (const key in record) run(key)
  while (ready) run()
  do { run() } while (ready)
}`
    for (const absoluteSourceRanges of [true, false]) {
      const context = compileSemanticSource('/workspace/control.ts', source, { absoluteSourceRanges })
      const fn = context.sourceFile.statements.find(ts.isFunctionDeclaration)!
      const statements = fn.body!.statements
      const firstIf = statements[0] as ts.IfStatement
      expect(composeIfHeader(firstIf, context).text).toBe('If `status` strictly equals `200`:')
      expect(composeIfPath('then', firstIf.thenStatement, context).text).toBe('Then:')
      expect(composeIfPath('otherwise', firstIf.elseStatement!, context).text).toBe('Otherwise:')
      expect(composeIfHeader(statements[1] as ts.IfStatement, context).text).toBe('If `ready` is truthy:')

      expect(composeIfHeader(statements[2] as ts.IfStatement, context).text).toBe('If `left = right` is truthy:')

      const switchNode = statements[3] as ts.SwitchStatement
      expect(composeSwitchHeader(switchNode, context).text).toBe('Switch on `state`:')
      expect(switchNode.caseBlock.clauses.map((clause) => composeSwitchPath(clause, context).text))
        .toEqual(['When `\'ready\'` matches:', 'Otherwise:'])

      const tryWithBinding = statements[4] as ts.TryStatement
      expect(composeTryHeader(tryWithBinding, context).text).toBe('Try:')
      expect(composeCatchHeader(tryWithBinding.catchClause!, context).text).toBe('Catch error `error`:')
      expect(composeFinallyHeader(tryWithBinding.finallyBlock!, context).text).toBe('Finally:')
      const catchWithoutBinding = (statements[5] as ts.TryStatement).catchClause!
      expect(composeCatchHeader(catchWithoutBinding, context).text).toBe('Catch:')

      expect(statements.slice(6).map((statement) => composeLoopHeader(statement as never, context).text)).toEqual([
        'Repeat with setup `let i = 0`, while `i` is less than `2`, and after each pass `i += 1`:',
        'Repeat:',
        'For each `item` in `items`:',
        'For await each `event` in `stream`:',
        'For each key `key` in `record`:',
        'While `ready` is truthy:',
        'Repeat, then continue while `ready` is truthy:',
      ])

      for (const rendered of [
        composeIfHeader(firstIf, context),
        composeSwitchHeader(switchNode, context),
        composeTryHeader(tryWithBinding, context),
        composeLoopHeader(statements[6] as ts.ForStatement, context),
      ]) {
        expect(Boolean(rendered.sourceRange)).toBe(absoluteSourceRanges)
      }
    }
  })

  it('retains nested API and async evidence in control-flow conditions', () => {
    const source = `async function scenario() {
  if (await fetch('/ready')) run()
  switch (fetch('/state')) { default: stop() }
  while (await fetch('/next')) run()
  for (fetch('/setup'); await fetch('/again');) run()
  for await (const item of fetch('/stream')) run(item)
}`
    const context = compileSemanticSource('/workspace/semantic-control.ts', source)
    const fn = context.sourceFile.statements.find(ts.isFunctionDeclaration)!
    const [ifNode, switchNode, whileNode, forNode, forAwaitNode] = fn.body!.statements
    const blocks = [
      composeIfHeader(ifNode as ts.IfStatement, context),
      composeSwitchHeader(switchNode as ts.SwitchStatement, context),
      composeLoopHeader(whileNode as ts.WhileStatement, context),
      composeLoopHeader(forNode as ts.ForStatement, context),
      composeLoopHeader(forAwaitNode as ts.ForOfStatement, context),
    ]
    expect(blocks.map((item) => item.semanticCategories)).toEqual([
      ['external-api', 'branch', 'async', 'function-call'],
      ['external-api', 'branch', 'function-call'],
      ['external-api', 'iteration', 'async', 'function-call'],
      ['external-api', 'iteration', 'async', 'function-call'],
      ['external-api', 'iteration', 'async', 'function-call'],
    ])
    expect(blocks.every((item) => (
      item.spans.some((span) => span.semanticCategories?.includes('external-api'))
    ))).toBe(true)
  })

  it('renders plain and code spans byte-for-byte', () => {
    expect(renderEnglishSpans([
      { text: 'Use ' },
      { text: 'value', kind: 'code' },
      { text: '.' },
    ])).toBe('Use `value`.')
  })

  it('falls back instead of hiding unsupported assertion modifiers or arguments', () => {
    const context = compileSemanticSource('/workspace/assertion-precision.ts', `function scenario() {
  expect(actual, 'message').toBe(expected)
  expect(actual).toBe(expected, 'extra')
  expect(actual).resolves.toBe(expected)
  expect(actual).not.not.toBe(expected)
}`)
    const fn = context.sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration => (
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'scenario'
      ),
    )!
    expect(fn.body!.statements.map((statement) => composeStatementEnglish(statement, context)?.text))
      .toEqual([
        "Call `expect(actual, 'message').toBe(expected)`.",
        "Call `expect(actual).toBe(expected, 'extra')`.",
        'Call `expect(actual).resolves.toBe(expected)`.',
        'Call `expect(actual).not.not.toBe(expected)`.',
      ])
  })
})
