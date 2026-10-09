import { describe, expect, it } from 'vitest'
import type { ExtractedTest } from '../extracted-test'
import type { ReadableStoryItem } from '../readable-tests/types'
import type { TestFileReview } from '../test-review'
import { sourceRows } from '../test-source-diff'
import {
  alignedEnglishAvailable,
  alignedGutterWidth,
  alignedSideLabels,
  alignedTestViewRows,
  bodyLineForSourceLine,
  buildTestViewRows,
  markedRowIndexes,
  sourceBelongsToTestBody,
  sourceLineForBodyLine,
  storyChangeMarks,
  testBodyLine,
  testViewSource,
} from './render-model'

const FILE = '/repo/e2e/checkout.spec.ts'

function step(id: string, startLine: number, endLine = startLine, file = FILE): ReadableStoryItem {
  return { id, role: 'action', text: id, spans: [{ text: id }], fidelity: 'derived', source: { file, startLine, endLine, snippet: id } }
}

function extracted(overrides: Partial<ExtractedTest> = {}): ExtractedTest {
  return {
    name: 'completes checkout',
    line: 7,
    bodyLine: 10,
    bodySource: "{\n  await page.goto('/checkout')\n  expect(page).toBeTruthy()\n}",
    steps: [],
    readable: { version: 2, title: 'completes checkout', completeness: 'complete', nodes: [], story: { steps: [step('open', 11), step('check', 12)] } },
    ...overrides,
  }
}

describe('body line arithmetic', () => {
  it('counts from the callback body, falling back to the declaration line', () => {
    expect(testBodyLine(extracted())).toBe(10)
    expect(testBodyLine(extracted({ bodyLine: undefined }))).toBe(7)
    expect(sourceLineForBodyLine(extracted(), 3)).toBe(12)
    expect(bodyLineForSourceLine(extracted(), 12)).toBe(3)
  })

  it('treats only same-file ranges inside the body as the body', () => {
    const test = extracted()
    expect(sourceBelongsToTestBody(test, FILE, { file: FILE, startLine: 11, endLine: 12, snippet: '' })).toBe(true)
    expect(sourceBelongsToTestBody(test, FILE, { file: FILE, startLine: 9, endLine: 12, snippet: '' })).toBe(false)
    expect(sourceBelongsToTestBody(test, FILE, { file: '/repo/helpers.ts', startLine: 11, endLine: 12, snippet: '' })).toBe(false)
  })
})

describe('testViewSource', () => {
  it('strips the standalone wrapper braces and their shared indentation, keeping absolute lines', () => {
    expect(testViewSource(extracted(), FILE)).toEqual({
      file: FILE, startLine: 10, endLine: 13,
      source: "await page.goto('/checkout')\nexpect(page).toBeTruthy()",
      lineMap: [{ sourceLine: 11, sourceLines: [11] }, { sourceLine: 12, sourceLines: [12] }],
    })
  })

  it('shows an empty body as no rows and a brace-less body untouched', () => {
    expect(testViewSource(extracted({ bodySource: '{ }' }), FILE)).toMatchObject({ source: '', lineMap: [], endLine: 10 })
    expect(testViewSource(extracted({ bodySource: 'run()' }), FILE)).toMatchObject({ source: 'run()', lineMap: [{ sourceLine: 10, sourceLines: [10] }] })
    expect(testViewSource(extracted({ bodySource: '{\n  run()' }), FILE)).toMatchObject({ source: '{\n  run()', lineMap: [{ sourceLine: 10, sourceLines: [10] }, { sourceLine: 11, sourceLines: [11] }] })
  })

  it('keeps blank-only wrapper contents without dedenting them', () => {
    expect(testViewSource(extracted({ bodySource: '{\n\n   \n}' }), FILE)).toMatchObject({ source: '\n   ', lineMap: [{ sourceLine: 11, sourceLines: [11] }, { sourceLine: 12, sourceLines: [12] }] })
  })

  it('uses the server-formatted display only when its line map matches its rows', () => {
    const codeDisplay = {
      code: '{\n    const message = find() as Message | undefined;\n    await send(message);\n}',
      lineMap: [{ sourceLine: 10, sourceLines: [10] }, { sourceLine: 11, sourceLines: [11, 12, 13] }, { sourceLine: 14, sourceLines: [14] }, { sourceLine: 15, sourceLines: [15] }],
    }
    expect(testViewSource(extracted({ codeDisplay }), FILE)).toMatchObject({
      source: 'const message = find() as Message | undefined;\nawait send(message);',
      lineMap: codeDisplay.lineMap.slice(1, -1),
    })
    const stale = { code: codeDisplay.code, lineMap: codeDisplay.lineMap.slice(0, 2) }
    expect(testViewSource(extracted({ codeDisplay: stale }), FILE).source).toBe("await page.goto('/checkout')\nexpect(page).toBeTruthy()")
  })

  it('lists an opened helper snippet by its own file and lines', () => {
    const helper = { file: '/repo/helpers.ts', startLine: 30, endLine: 32, snippet: '{\n  expect(account.active).toBe(true)\n}' }
    expect(testViewSource(extracted(), FILE, helper)).toEqual({
      file: '/repo/helpers.ts', startLine: 30, endLine: 32,
      source: 'expect(account.active).toBe(true)',
      lineMap: [{ sourceLine: 31, sourceLines: [31] }],
    })
  })
})

describe('buildTestViewRows', () => {
  it('numbers rows physically, names the English step each begins, and marks the run and the edits', () => {
    const rows = buildTestViewRows({ test: extracted(), sourceFile: FILE, execution: { kind: 'failed', bodyLine: 3 }, changedBodyLines: new Set([2, 3]) })
    expect(rows).toEqual([
      { index: 1, sourceLine: 11, endLine: 11, sourceLines: [11], label: '01', story: { sequence: '01', label: '01' }, continued: false, code: "await page.goto('/checkout')", marks: { changes: new Set(), selected: false, changed: true } },
      { index: 2, sourceLine: 12, endLine: 12, sourceLines: [12], label: '02', story: { sequence: '02', label: '02' }, continued: false, code: 'expect(page).toBeTruthy()', marks: { changes: new Set(), selected: false, changed: true, execution: 'failed' } },
    ])
    expect(markedRowIndexes(rows, (marks) => marks.execution !== undefined)).toEqual(new Set([2]))
    expect(markedRowIndexes(rows, (marks) => marks.changed)).toEqual(new Set([1, 2]))
    expect(markedRowIndexes(rows, (marks) => marks.selected)).toBeUndefined()
  })

  it('leaves rows unnumbered by the story when the payload has none, and blank when no step begins there', () => {
    const withoutStory = extracted({ readable: { version: 2, title: 't', completeness: 'partial', nodes: [] } })
    expect(buildTestViewRows({ test: withoutStory, sourceFile: FILE }).map((row) => row.story)).toEqual([undefined, undefined])
    const partial = extracted({ readable: { version: 2, title: 't', completeness: 'partial', nodes: [], story: { steps: [step('check', 12)] } } })
    expect(buildTestViewRows({ test: partial, sourceFile: FILE }).map((row) => row.story)).toEqual([undefined, { sequence: '01', label: '01' }])
  })

  it('shows a compacted statement’s number once and keeps its empty server mapping to one line', () => {
    const codeDisplay = {
      code: '{\n  const message = find() as\n    Message | undefined;\n  ;\n}',
      lineMap: [{ sourceLine: 10, sourceLines: [10] }, { sourceLine: 11, sourceLines: [11, 12] }, { sourceLine: 12, sourceLines: [12] }, { sourceLine: 13, sourceLines: [] }, { sourceLine: 14, sourceLines: [14] }],
    }
    const test = extracted({ bodySource: '{\n  const message = find() as\n    Message | undefined\n  ;\n}', codeDisplay, readable: { version: 2, title: 't', completeness: 'complete', nodes: [], story: { steps: [step('find', 11, 12)] } } })
    const rows = buildTestViewRows({ test, sourceFile: FILE, selectedSource: { file: FILE, startLine: 13, endLine: 13, snippet: ';' }, changedBodyLines: new Set([4]) })
    expect(rows.map((row) => [row.story?.sequence, row.endLine, row.marks.selected, row.marks.changed])).toEqual([
      ['01', 12, false, false],
      [undefined, 12, false, false],
      [undefined, 13, true, false],
    ])
  })

  it('never carries run or change marks onto a helper snippet that shares the body’s line numbers', () => {
    const helper = { file: '/repo/helpers.ts', startLine: 10, endLine: 13, snippet: extracted().bodySource }
    const rows = buildTestViewRows({ test: extracted(), sourceFile: FILE, selectedSource: helper, execution: { kind: 'running', bodyLine: 2 }, changedBodyLines: new Set([2]) })
    expect(rows.map((row) => row.marks)).toEqual([
      { changes: new Set(), selected: true, changed: false },
      { changes: new Set(), selected: true, changed: false },
    ])
  })

  it('keeps marks when the opened English row lies inside the body', () => {
    const rows = buildTestViewRows({ test: extracted(), sourceFile: FILE, selectedSource: { file: FILE, startLine: 12, endLine: 12, snippet: '' }, execution: { kind: 'running', bodyLine: 2 }, changedBodyLines: new Set() })
    expect(rows.map((row) => row.marks)).toEqual([
      { changes: new Set(), selected: false, changed: false, execution: 'running' },
      { changes: new Set(), selected: true, changed: false },
    ])
  })
})

describe('storyChangeMarks', () => {
  it('maps changed body lines to their English rows and lists the rest', () => {
    const test = extracted({ bodySource: "{\n  await page.goto('/checkout')\n  // expect(order).toBeDefined()\n}", readable: { version: 2, title: 't', completeness: 'partial', nodes: [], story: { steps: [step('open', 11)] } } })
    expect(storyChangeMarks(test, FILE, new Set([3, 2]))).toEqual({ nodeIds: new Set(['open']), unmappedSourceLines: [12] })
    expect(storyChangeMarks(test, FILE, undefined)).toEqual({ unmappedSourceLines: [] })
    expect(storyChangeMarks(test, FILE, new Set())).toEqual({ unmappedSourceLines: [] })
    const withoutStory = extracted({ readable: { version: 2, title: 't', completeness: 'partial', nodes: [] } })
    expect(storyChangeMarks(withoutStory, FILE, new Set([2]))).toEqual({ unmappedSourceLines: [11] })
  })
})

const REVIEW_FILE = 'e2e/a.spec.ts'

function review(before: string[], after: string[], overrides: Partial<TestFileReview> = {}): TestFileReview {
  const pairs = Math.max(before.length, after.length)
  const patch = `@@ -1,${before.length} +1,${after.length} @@\n` + Array.from({ length: pairs }, (_, i) => before[i] === after[i] ? [' ' + before[i]]
    : [...(before[i] === undefined ? [] : ['-' + before[i]]), ...(after[i] === undefined ? [] : ['+' + after[i]])]).flat().join('\n')
  return {
    file: REVIEW_FILE, currentPath: `/tmp/${REVIEW_FILE}`, baseline: 'head', patch,
    before: { source: before.join('\n'), tests: [] },
    after: { source: after.join('\n'), tests: [] },
    assessment: { verdict: 'unclassifiable', tests: [] },
    ...overrides,
  }
}

function fileStep(id: string, startLine: number, endLine = startLine): ReadableStoryItem {
  return step(id, startLine, endLine, REVIEW_FILE)
}

describe('alignedTestViewRows', () => {
  it('in Code mode keeps every pair, labels each side by its line, and marks only the edited side', () => {
    const data = review(['a', 'b', 'c'], ['a', 'B', 'c'])
    const rows = sourceRows(data).map((row) => ({ ...row, beforeChanged: false }))
    const aligned = alignedTestViewRows({ review: data, rows, mode: 'code', change: 1 })
    expect(aligned.map((pair) => [pair.before?.label, pair.after?.label, pair.selected, pair.sourceChanged])).toEqual([
      ['1', '1', false, false],
      ['2', '2', true, true],
      ['3', '3', false, false],
    ])
    expect(aligned[1].before?.marks).toEqual({ changes: new Set(), selected: false, changed: false })
    expect(aligned[1].after).toEqual({
      index: 2, sourceLine: 2, endLine: 2, sourceLines: [2], label: '2', continued: false, code: 'B',
      marks: { changes: new Set([1]), selected: false, changed: true },
    })
    expect(aligned[1].source).toBe(rows[1])
  })

  it('keeps an inserted or removed line aligned with an absent opposite side', () => {
    const inserted = review(['a', 'c'], ['a', 'b', 'c'], { patch: '@@ -1,2 +1,3 @@\n a\n+b\n c' })
    const rows = alignedTestViewRows({ review: inserted, rows: sourceRows(inserted), mode: 'code', change: 1 })
    expect(rows.map((pair) => [pair.before?.sourceLine, pair.after?.sourceLine, pair.selected])).toEqual([[1, 1, false], [undefined, 2, true], [2, 3, false]])
    expect(rows[1].before).toBeUndefined()
    const removed = review(['a', 'b', 'c'], ['a', 'c'], { patch: '@@ -1,3 +1,2 @@\n a\n-b\n c' })
    const back = alignedTestViewRows({ review: removed, rows: sourceRows(removed), mode: 'code' })
    expect(back.map((pair) => [pair.before?.sourceLine, pair.after?.sourceLine, pair.sourceChanged])).toEqual([[1, 1, false], [2, undefined, true], [3, 2, false]])
  })

  it('selects the Code-mode rows inside the opened range on the chosen side only', () => {
    const data = review(['a', 'b', 'c'], ['a', 'b', 'c'])
    const rows = sourceRows(data)
    const selected = alignedTestViewRows({ review: data, rows, mode: 'code', selection: { side: 'after', line: 2, endLine: 3 } })
    expect(selected.map((pair) => [pair.before?.marks.selected, pair.after?.marks.selected])).toEqual([[false, false], [false, true], [false, true]])
    expect(alignedTestViewRows({ review: data, rows, mode: 'code', selection: null }).every((pair) => !pair.after?.marks.selected)).toBe(true)
    expect(alignedTestViewRows({ review: data, rows, mode: 'english', selection: { side: 'after', line: 1, endLine: 3 } }).every((pair) => !pair.after?.marks.selected)).toBe(true)
  })

  it('in English mode folds a statement into its first row and collapses pairs that only continue it', () => {
    const lines = ['import {', '  api,', '  fixture,', '} from "./fixture";', 'helper()']
    const story = { steps: [fileStep('import', 1, 4), fileStep('helper', 5)] }
    const data = review(lines, lines, { before: { source: lines.join('\n'), tests: [], story }, after: { source: lines.join('\n'), tests: [], story } })
    const aligned = alignedTestViewRows({ review: data, rows: sourceRows(data), mode: 'english' })
    expect(aligned.map((pair) => [pair.before?.index, pair.before?.label, pair.before?.endLine, pair.before?.sourceLines])).toEqual([
      [1, '1–4', 4, [1, 2, 3, 4]],
      [2, '5', 5, [5]],
    ])
    expect(aligned[0].after?.english?.map(({ step, depth }) => [step.id, depth])).toEqual([['import', 0]])
    expect(aligned[1].after?.english?.map(({ step }) => step.id)).toEqual(['helper'])
  })

  it('keeps a continuation row when the other side has its own content, blank and unlabelled', () => {
    const lines = ['import {', '  api,', '} from "./fixture";']
    const story = { steps: [fileStep('import', 1, 3)] }
    const data = review(lines, lines, { after: { source: lines.join('\n'), tests: [], story } })
    const aligned = alignedTestViewRows({ review: data, rows: sourceRows(data), mode: 'english' })
    expect(aligned).toHaveLength(3)
    expect(aligned[1].after).toEqual({
      index: 2, sourceLine: 2, endLine: 3, sourceLines: [2, 3], continued: true, code: '  api,',
      marks: { changes: new Set(), selected: false, changed: false },
    })
    expect(aligned[1].before).toMatchObject({ label: '2', continued: false })
    expect(aligned[1].before?.english).toBeUndefined()
  })

  it('collects every edit inside a folded range and selects the pair for any of them', () => {
    const lines = ['import {', '  api,', '  fixture,', '} from "./fixture";']
    const story = { steps: [fileStep('import', 1, 4)] }
    const data = review(lines, lines, { before: { source: lines.join('\n'), tests: [], story }, after: { source: lines.join('\n'), tests: [], story } })
    const rows = sourceRows(data)
    rows[1] = { ...rows[1], change: 1, after: '  changed1,' }
    rows[2] = { ...rows[2], change: 2, after: '  changed2,' }
    for (const change of [1, 2]) {
      const aligned = alignedTestViewRows({ review: data, rows, mode: 'english', change })
      expect(aligned).toHaveLength(1)
      expect(aligned[0].selected).toBe(true)
      expect([...aligned[0].after!.marks.changes]).toEqual([1, 2])
    }
    expect(alignedTestViewRows({ review: data, rows, mode: 'english', change: 3 })[0].selected).toBe(false)
  })

  it('inside a test, English rows take only the edits the server calls meaningful', () => {
    const before = ["test('a', {", "  tag: ['@req-R18'],", '}, async () => {', '  check()', '})']
    const after = [...before]
    after[1] = "  tag: ['@req-R18', '@req-R19'],"
    const readable = { version: 2 as const, title: 'a', completeness: 'complete' as const, nodes: [] }
    const data = review(before, after, {
      before: { source: before.join('\n'), tests: [{ name: 'a', line: 1, endLine: 5, readable }], story: { steps: [fileStep('test', 1, 3), fileStep('check', 4)] } },
      after: { source: after.join('\n'), tests: [{ name: 'a', line: 1, endLine: 5, readable }], story: { steps: [fileStep('test', 1, 3), fileStep('check', 4)] } },
      meaningfulChanges: { before: [], after: [] },
    })
    const rows = sourceRows(data)
    expect(alignedTestViewRows({ review: data, rows, mode: 'english', change: 1 }).map((pair) => [pair.after?.label, pair.sourceChanged])).toEqual([['1–3', false], ['4', false], ['5', false]])
    expect(alignedTestViewRows({ review: { ...data, meaningfulChanges: { before: [], after: [2] } }, rows, mode: 'english', change: 1 }).map((pair) => pair.sourceChanged)).toEqual([true, false, false])
    expect(alignedTestViewRows({ review: { ...data, meaningfulChanges: undefined }, rows, mode: 'english', change: 1 }).map((pair) => pair.sourceChanged)).toEqual([true, false, false])
    expect(alignedTestViewRows({ review: data, rows, mode: 'code', change: 1 }).map((pair) => pair.sourceChanged)).toEqual([false, true, false, false, false])
  })

  it('outside any test, English rows take every edit even with a meaningful filter', () => {
    const before = ['import { a } from "x"', 'helper()']
    const after = ['import { a, b } from "x"', 'helper()']
    const story = (lines: string[]) => ({ steps: [fileStep('import', 1), fileStep('helper', 2)] , source: lines.join('\n'), tests: [] })
    const data = review(before, after, { before: story(before), after: story(after), meaningfulChanges: { before: [], after: [] } })
    expect(alignedTestViewRows({ review: data, rows: sourceRows(data), mode: 'english', change: 1 }).map((pair) => pair.sourceChanged)).toEqual([true, false])
  })

  it('ignores an edit on a side the diff marks as unchanged, and a row whose side has no text', () => {
    const data = review(['a', 'b'], ['a', 'B'])
    const rows = sourceRows(data).map((row) => ({ ...row, afterChanged: false }))
    const aligned = alignedTestViewRows({ review: data, rows, mode: 'code', change: 1 })
    expect(aligned[1].before?.marks.changes).toEqual(new Set([1]))
    expect(aligned[1].after?.marks.changes).toEqual(new Set())
    const blank = alignedTestViewRows({ review: data, rows: [{ id: 'odd', before: null, after: 'x', beforeLine: 1, afterLine: 1 }], mode: 'code' })
    expect(blank[0].before?.code).toBe('')
  })
})

describe('aligned view facts', () => {
  it('offers English for a spec file always, and for a supporting file only when a side has a story', () => {
    const spec = review(['a'], ['a'])
    expect(alignedEnglishAvailable(spec)).toBe(true)
    const supporting = review(['a'], ['a'], { supportingFile: true })
    expect(alignedEnglishAvailable(supporting)).toBe(false)
    expect(alignedEnglishAvailable({ ...supporting, after: { source: 'a', tests: [], story: { steps: [fileStep('a', 1)] } } })).toBe(true)
    expect(alignedEnglishAvailable({ ...supporting, before: { source: 'a', tests: [], story: { steps: [fileStep('a', 1)] } } })).toBe(true)
    expect(alignedEnglishAvailable({ ...supporting, after: { source: 'a', tests: [], story: { steps: [] } } })).toBe(false)
  })

  it('names the baseline column after what the current source is compared against', () => {
    expect(alignedSideLabels(review(['a'], ['a']))).toEqual({ before: 'Committed tests · Git HEAD', after: 'Current source' })
    expect(alignedSideLabels(review(['a'], ['a'], { baseline: 'run-start' }))).toEqual({ before: 'Recorded tests', after: 'Current source' })
  })

  it('keeps the two-character gutter until a line label outgrows it', () => {
    const short = review(['a', 'b'], ['a', 'b'])
    expect(alignedGutterWidth(alignedTestViewRows({ review: short, rows: sourceRows(short), mode: 'code' }))).toBe(2)
    const lines = ['import {', '  api,', '  fixture,', '} from "./fixture";']
    const story = { steps: [fileStep('import', 1, 4)] }
    const folded = review(lines, lines, { after: { source: lines.join('\n'), tests: [], story } })
    expect(alignedGutterWidth(alignedTestViewRows({ review: folded, rows: sourceRows(folded), mode: 'english' }))).toBe(3)
    expect(alignedGutterWidth([])).toBe(2)
  })
})
