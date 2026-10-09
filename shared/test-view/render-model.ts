// The one row model behind every surface that shows test source: the Tests
// column and coverage cards, the before/after review, and (later) the server
// report. Rows are plain data so the web renderers and the HTML string renderer
// read the same facts; nothing here may know about React, the DOM, or a bundler
// alias.
import type { FormattedCodeDisplay, FormattedDisplayLine } from '../code-display-format'
import type { ExtractedTest } from '../extracted-test'
import { englishLines, englishSourceRange } from '../readable-tests/source-lines'
import { storyCodeLineNumbers, storyItemIdForSourceLine, type StoryCodeLineNumber } from '../readable-tests/story-source-map'
import type { ReadableSource, ReadableStoryItem } from '../readable-tests/types'
import type { TestFileReview } from '../test-review'
import type { ContextRow } from '../test-source-diff'

export type TestViewMode = 'english' | 'code'
export type TestViewSide = 'before' | 'after'
export type TestViewExecution = 'running' | 'failed'

/** One English statement that begins on a row, with its nesting depth. */
export interface TestViewStep { step: ReadableStoryItem; depth: number }

export interface TestViewMarks {
  /** Edit ids (`ContextRow.change`) that touch the row's source range. */
  changes: ReadonlySet<number>
  /** The row sits inside the source range the reader opened. */
  selected: boolean
  /** The row's source differs from the baseline it is compared against. */
  changed: boolean
  /** The run is on this row, or last failed on it. */
  execution?: TestViewExecution
}

/** One rendered row of test source. A single listing renders one per display
 * line; an aligned listing renders one per side of each pair. */
export interface TestViewRow {
  /** 1-based position in its listing. */
  index: number
  /** The absolute source line navigation and story lookups target. */
  sourceLine: number
  /** The last absolute source line the row folds in: a compacted multi-line
   * expression, or the whole statement an English row describes. */
  endLine: number
  /** Every absolute source line the row stands for. */
  sourceLines: readonly number[]
  /** Gutter text. Absent on a continuation, whose gutter stays blank. */
  label?: string
  /** The English step whose number this row shows beside the code. */
  story?: StoryCodeLineNumber
  /** English statements that begin on this row, when the listing shows English. */
  english?: readonly TestViewStep[]
  /** The statement began on an earlier row: the row keeps its place but shows nothing. */
  continued: boolean
  /** The row's text as displayed. */
  code: string
  marks: TestViewMarks
}

export interface TestViewSource {
  file: string
  startLine: number
  endLine: number
  /** Display text, one line per `lineMap` entry; empty when the body holds no statements. */
  source: string
  lineMap: FormattedDisplayLine[]
}

export interface TestViewSourceInput {
  test: ExtractedTest
  sourceFile: string
  /** The English row the reader opened; absent shows the whole test body. */
  selectedSource?: ReadableSource
  /** Body-relative rows (1 is the body's first line), as run results report them. */
  execution?: { kind: TestViewExecution; bodyLine: number }
  changedBodyLines?: ReadonlySet<number>
}

export function testBodyLine(test: ExtractedTest): number {
  return test.bodyLine ?? test.line
}

/** Run results and change sets count from the body's first line; the editor
 * and the story count from the file's. */
export function sourceLineForBodyLine(test: ExtractedTest, bodyLine: number): number {
  return testBodyLine(test) + bodyLine - 1
}

export function bodyLineForSourceLine(test: ExtractedTest, sourceLine: number): number {
  return sourceLine - testBodyLine(test) + 1
}

export function sourceBelongsToTestBody(test: ExtractedTest, sourceFile: string, source: ReadableSource): boolean {
  if (source.file !== sourceFile) return false
  const bodyLine = testBodyLine(test)
  return source.startLine >= bodyLine && source.endLine <= testBodyEndLine(test)
}

function testBodyEndLine(test: ExtractedTest): number {
  return testBodyLine(test) + Math.max(test.bodySource.split('\n').length - 1, 0)
}

/** The listing a reader sees in Code mode: a helper snippet when the opened
 * English row lives outside the body, otherwise the body itself. */
export function testViewSource(test: ExtractedTest, sourceFile: string, selectedSource?: ReadableSource): TestViewSource {
  if (selectedSource && !sourceBelongsToTestBody(test, sourceFile, selectedSource)) {
    const display = displayCodeSource(selectedSource.snippet, selectedSource.startLine)
    return { ...display, file: selectedSource.file, startLine: selectedSource.startLine, endLine: selectedSource.endLine }
  }
  const startLine = testBodyLine(test)
  const display = displayCodeSource(test.bodySource, startLine, test.codeDisplay)
  return { ...display, file: sourceFile, startLine, endLine: testBodyEndLine(test) }
}

/** Test callback bodies arrive as `{ ... }`. Code mode is already scoped to
 * that body, so showing the wrapper adds two rows that English mode cannot have.
 * Remove only standalone wrapper lines and their shared indentation; source
 * navigation keeps using the original absolute lines. */
function displayCodeSource(
  source: string,
  startLine: number,
  formatted?: FormattedCodeDisplay,
): { source: string; lineMap: FormattedDisplayLine[] } {
  const usableDisplay = formatted && formatted.lineMap.length === formatted.code.split('\n').length
    ? formatted
    : {
        code: source,
        lineMap: source.split('\n').map((_, index) => ({
          sourceLine: startLine + index,
          sourceLines: [startLine + index],
        })),
      }
  const lines = usableDisplay.code.split('\n')
  if (lines.length === 1 && /^\{\s*\}$/.test(lines[0])) {
    return { source: '', lineMap: [] }
  }
  if (lines.length < 2 || lines[0].trim() !== '{' || lines[lines.length - 1].trim() !== '}') {
    return { source: usableDisplay.code, lineMap: usableDisplay.lineMap }
  }
  const inner = lines.slice(1, -1)
  const indentation = inner
    .filter((line) => line.trim())
    .reduce((least, line) => Math.min(least, line.length - line.trimStart().length), Infinity)
  const dedented = Number.isFinite(indentation)
    ? inner.map((line) => line.slice(Math.min(indentation, line.length)))
    : inner
  return { source: dedented.join('\n'), lineMap: usableDisplay.lineMap.slice(1, -1) }
}

/** Rows of one listing. Execution and change marks belong to the test body, so
 * a helper snippet that happens to share its line numbers never inherits them. */
export function buildTestViewRows(input: TestViewSourceInput): TestViewRow[] {
  const { test, sourceFile, selectedSource, execution, changedBodyLines } = input
  const listing = testViewSource(test, sourceFile, selectedSource)
  const showingBody = !selectedSource || sourceBelongsToTestBody(test, sourceFile, selectedSource)
  const executionLines = showingBody && execution ? new Set([sourceLineForBodyLine(test, execution.bodyLine)]) : undefined
  const changedLines = showingBody && changedBodyLines?.size
    ? new Set([...changedBodyLines].map((line) => sourceLineForBodyLine(test, line)))
    : undefined
  const steps = test.readable.story?.steps
  const storyNumbers = steps ? storyCodeLineNumbers(steps, listing.file, listing.startLine, listing.endLine) : undefined
  const shownStories = new Set<string>()
  const displayLines = listing.source.split('\n')
  return listing.lineMap.map((mapping, index) => {
    const { sourceLine } = mapping
    // The display map may arrive from the server with an empty `sourceLines`;
    // the row then stands for its primary line alone. Run and change marks keep
    // reading the raw map, so a row the server left unmapped never lights up.
    const sourceLines = mapping.sourceLines.length ? mapping.sourceLines : [sourceLine]
    const story = storyNumbers && sourceLines.map((line) => storyNumbers.get(line)).find(Boolean)
    // A compacted statement spans several display rows; its number shows once.
    const shown = story !== undefined && !shownStories.has(story.sequence)
    if (story && shown) shownStories.add(story.sequence)
    const hasMark = (lines: ReadonlySet<number> | undefined): boolean => lines !== undefined && mapping.sourceLines.some((line) => lines.has(line))
    const executionKind = execution && hasMark(executionLines) ? execution.kind : undefined
    return {
      index: index + 1,
      sourceLine,
      endLine: Math.max(sourceLine, ...sourceLines),
      sourceLines,
      label: String(index + 1).padStart(2, '0'),
      ...(story && shown ? { story } : {}),
      continued: false,
      code: displayLines[index],
      marks: {
        changes: new Set<number>(),
        selected: selectedSource !== undefined && sourceLines.some((line) => line >= selectedSource.startLine && line <= selectedSource.endLine),
        changed: hasMark(changedLines),
        ...(executionKind ? { execution: executionKind } : {}),
      },
    }
  })
}

/** 1-based display rows that carry a mark, the shape a renderer keyed by
 * display position consumes. */
export function markedRowIndexes(rows: readonly TestViewRow[], marked: (marks: TestViewMarks) => boolean): Set<number> | undefined {
  const indexes = new Set(rows.filter((row) => marked(row.marks)).map((row) => row.index))
  return indexes.size ? indexes : undefined
}

export interface StoryChangeMarks {
  /** English rows whose source changed. Absent when there is no story to mark. */
  nodeIds?: ReadonlySet<string>
  /** Changed source rows no English row describes, ascending. */
  unmappedSourceLines: number[]
}

/** Which English rows a set of changed body lines lands on, and which changes
 * no English row can show (a commented-out check, for one). */
export function storyChangeMarks(test: ExtractedTest, sourceFile: string, changedBodyLines: ReadonlySet<number> | undefined): StoryChangeMarks {
  if (!changedBodyLines?.size) return { unmappedSourceLines: [] }
  const sourceLines = [...changedBodyLines].sort((a, b) => a - b).map((line) => sourceLineForBodyLine(test, line))
  const steps = test.readable.story?.steps
  if (!steps) return { unmappedSourceLines: sourceLines }
  const nodeIds = new Set<string>()
  const unmappedSourceLines: number[] = []
  for (const sourceLine of sourceLines) {
    const nodeId = storyItemIdForSourceLine(steps, sourceFile, sourceLine)
    if (nodeId) nodeIds.add(nodeId)
    else unmappedSourceLines.push(sourceLine)
  }
  return { nodeIds, unmappedSourceLines }
}

export interface TestViewSelection { side: TestViewSide; line: number; endLine: number }

export interface TestViewAlignedInput {
  review: TestFileReview
  rows: ContextRow[]
  mode: TestViewMode
  /** The edit whose rows read as selected. */
  change?: number
  /** The Code-mode range the reader opened from English. */
  selection?: TestViewSelection | null
}

/** One pair of the before/after review. A side is absent when that version has
 * no line here (an insertion or deletion). */
export interface TestViewAlignedRow {
  source: ContextRow
  before?: TestViewRow
  after?: TestViewRow
  /** The pair carries the edit the reader is looking at. */
  selected: boolean
  sourceChanged: boolean
}

/** Keep diff rows source-aligned while English folds each statement into its
 * first row. A pair collapses only when neither side has independent content:
 * an insertion, deletion or differently wrapped statement keeps its alignment. */
export function alignedTestViewRows({ review, rows, mode, change, selection }: TestViewAlignedInput): TestViewAlignedRow[] {
  const english = { before: englishLines(review.before), after: englishLines(review.after) }
  const meaningful = review.meaningfulChanges ? {
    before: new Set(review.meaningfulChanges.before),
    after: new Set(review.meaningfulChanges.after),
  } : undefined
  const edits = { before: new Map<number, number>(), after: new Map<number, number>() }
  for (const row of rows) if (row.change != null) {
    if (row.beforeLine != null && row.beforeChanged !== false) edits.before.set(row.beforeLine, row.change)
    if (row.afterLine != null && row.afterChanged !== false) edits.after.set(row.afterLine, row.change)
  }
  const cell = (row: ContextRow, side: TestViewSide, index: number): TestViewRow | undefined => {
    const line = side === 'before' ? row.beforeLine : row.afterLine
    if (line == null) return undefined
    const story = english[side].get(line)
    const continued = mode === 'english' && story === null
    const range = mode === 'english' ? englishSourceRange(english[side], line) : { line, endLine: line }
    // Inside a test, only semantic edits mark an English row: a reworded tag or
    // a reformatted registration changes no behaviour the English describes.
    const insideTest = review[side].tests.some((test) => range.line >= test.line && range.line <= test.endLine)
    const changes = new Set<number>()
    if (!continued) for (let at = range.line; at <= range.endLine; at++) {
      const edit = edits[side].get(at)
      if (edit != null && (mode !== 'english' || !insideTest || !meaningful || meaningful[side].has(at))) changes.add(edit)
    }
    const sourceLines: number[] = []
    for (let at = continued ? line : range.line; at <= range.endLine; at++) sourceLines.push(at)
    return {
      index,
      sourceLine: line,
      endLine: range.endLine,
      sourceLines,
      ...(continued ? {} : { label: range.endLine > range.line ? `${range.line}–${range.endLine}` : String(range.line) }),
      ...(mode === 'english' && story ? { english: story } : {}),
      continued,
      code: row[side] ?? '',
      marks: {
        changes,
        selected: mode === 'code' && selection?.side === side && line >= selection.line && line <= selection.endLine,
        changed: changes.size > 0,
      },
    }
  }
  const aligned: TestViewAlignedRow[] = []
  for (const row of rows) {
    const index = aligned.length + 1
    const before = cell(row, 'before', index)
    const after = cell(row, 'after', index)
    if ((!before || before.continued) && (!after || after.continued)) continue
    const changes = [...(before?.marks.changes ?? []), ...(after?.marks.changes ?? [])]
    aligned.push({
      source: row,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      selected: change != null && changes.includes(change),
      sourceChanged: changes.length > 0,
    })
  }
  return aligned
}
