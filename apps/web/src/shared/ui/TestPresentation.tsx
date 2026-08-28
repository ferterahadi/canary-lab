import { useMemo, useState } from 'react'
import type { FormattedCodeDisplay, FormattedDisplayLine } from '@shared/code-display-format'
import type { ExtractedTest, ReadableSource } from '../api/types'
import type { TestExecutionLineHighlight } from '@/features/runs'
import { ReadableTestView, type ReadableSourceSelection } from './ReadableTestView'
import { ShikiCode, SourceOpenShell } from './TestCodeBlock'
import { storyCodeLineNumbers, storyItemIdForSourceLine } from './readable-story-sequence'

type PresentationMode = 'english' | 'code'

export function TestPresentation({
  test,
  sourceFile,
  executionHighlight,
  changedLines,
  showOpenButton = true,
}: {
  test: ExtractedTest
  sourceFile: string
  executionHighlight?: TestExecutionLineHighlight | null
  changedLines?: Set<number>
  showOpenButton?: boolean
}) {
  const [mode, setMode] = useState<PresentationMode>('english')
  const [selectedSource, setSelectedSource] = useState<ReadableSourceSelection | null>(null)

  const selectSource = (selection: ReadableSourceSelection) => {
    setSelectedSource(selection)
    setMode('code')
  }
  const showingFullTest = !selectedSource || sourceBelongsToTestBody(test, sourceFile, selectedSource.source)
  const code = codeSelection(test, sourceFile, selectedSource?.source)
  const visibleRange = selectedSource?.source ?? code
  const fullTestRange = codeSelection(test, sourceFile, undefined)
  const displayedExecutionLines = showingFullTest
    ? displayLinesForBodyLines(
        test,
        executionHighlight ? new Set([executionHighlight.bodyLine]) : undefined,
        code.lineMap,
      )
    : undefined
  const displayedChangedLines = showingFullTest
    ? displayLinesForBodyLines(test, changedLines, code.lineMap)
    : undefined
  const storyLineNumbers = useMemo(() => {
    const steps = test.readable.story?.steps
    if (!steps) return undefined
    return storyCodeLineNumbers(
      steps,
      code.file,
      code.startLine,
      code.endLine,
    )
  }, [code.endLine, code.file, code.startLine, test.readable.story?.steps])
  const executionSourceLine = executionHighlight
    ? testBodyLine(test) + executionHighlight.bodyLine - 1
    : undefined
  const executionStoryNodeId = executionSourceLine == null || !test.readable.story
    ? undefined
    : storyItemIdForSourceLine(test.readable.story.steps, sourceFile, executionSourceLine)

  return (
    <div data-testid="test-presentation">
      <div className="mb-2 flex min-w-0 items-center gap-2 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="cl-lang-switch" role="tablist" aria-label="Test description format" data-mode={mode}>
          <span className="cl-lang-switch-thumb" aria-hidden="true" />
          {/* Glyphs, not words: `Aa` reads as prose, `</>` as code. The
              accessible name stays the full word via aria-label/title. */}
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'english'}
            aria-label="English"
            title="English"
            data-active={mode === 'english' ? 'true' : 'false'}
            data-testid="test-presentation-english-tab"
            className="cl-lang-switch-btn"
            onClick={() => setMode('english')}
          >
            Aa
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'code'}
            aria-label="Code"
            title="Code"
            data-active={mode === 'code' ? 'true' : 'false'}
            data-testid="test-presentation-code-tab"
            className="cl-lang-switch-btn"
            onClick={() => setMode('code')}
          >
            {'</>'}
          </button>
        </div>
        {mode === 'english' && test.readable.completeness === 'partial' && (
          <span className="min-w-0 truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Some syntax could not be translated
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-right text-[10px]"
          title={mode === 'code' ? code.file : fullTestRange.file}
          style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
        >
          {mode === 'code'
            ? shortSourceLabel(visibleRange.file, visibleRange.startLine, visibleRange.endLine)
            : shortSourceLabel(fullTestRange.file, fullTestRange.startLine, fullTestRange.endLine)}
        </span>
        {mode === 'code' && selectedSource && (
          <button
            type="button"
            className="shrink-0 text-[10px]"
            style={{ color: 'var(--accent)' }}
            onClick={() => setSelectedSource(null)}
          >
            Full test
          </button>
        )}
      </div>

      {mode === 'english' ? (
        <div data-testid="test-presentation-english">
          <SourceOpenShell
            sourceLocation={{
              file: fullTestRange.file,
              startLine: firstMappedSourceLine(fullTestRange.lineMap) ?? fullTestRange.startLine,
            }}
            showOpenButton={showOpenButton}
          >
            <ReadableTestView
              test={test.readable}
              sourceFile={sourceFile}
              selectedNodeId={selectedSource?.id}
              executionHighlight={executionHighlight && executionStoryNodeId
                ? { kind: executionHighlight.kind, nodeId: executionStoryNodeId }
                : undefined}
              onSourceSelect={selectSource}
            />
          </SourceOpenShell>
        </div>
      ) : (
        <div data-testid="test-presentation-code">
          {code.source ? (
            <ShikiCode
              source={code.source}
              lineHighlight={executionHighlight && displayedExecutionLines
                ? { kind: executionHighlight.kind, lines: displayedExecutionLines }
                : undefined}
              sourceLocation={{ file: code.file, startLine: firstMappedSourceLine(code.lineMap) ?? code.startLine }}
              sourceLineMap={code.lineMap}
              changedLines={displayedChangedLines}
              showOpenButton={showOpenButton}
              selectedSourceRange={selectedSource?.source}
              storyLineNumbers={storyLineNumbers}
            />
          ) : (
            <div className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
              No test body available.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function codeSelection(
  test: ExtractedTest,
  sourceFile: string,
  selectedSource?: ReadableSource,
): {
  source: string
  file: string
  startLine: number
  endLine: number
  lineMap: FormattedDisplayLine[]
} {
  if (selectedSource && !sourceBelongsToTestBody(test, sourceFile, selectedSource)) {
    const display = displayCodeSource(selectedSource.snippet, selectedSource.startLine)
    return {
      source: display.source,
      file: selectedSource.file,
      startLine: selectedSource.startLine,
      endLine: selectedSource.endLine,
      lineMap: display.lineMap,
    }
  }
  const startLine = testBodyLine(test)
  const display = displayCodeSource(test.bodySource, startLine, test.codeDisplay)
  return {
    source: display.source,
    file: sourceFile,
    startLine,
    endLine: startLine + Math.max(test.bodySource.split('\n').length - 1, 0),
    lineMap: display.lineMap,
  }
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
  if (lines.length < 2 || lines[0].trim() !== '{' || lines.at(-1)?.trim() !== '}') {
    return { source: usableDisplay.code, lineMap: usableDisplay.lineMap }
  }
  const inner = lines.slice(1, -1)
  const indentation = inner
    .filter((line) => line.trim())
    .reduce((least, line) => Math.min(least, line.match(/^\s*/)?.[0].length ?? 0), Infinity)
  const dedented = Number.isFinite(indentation)
    ? inner.map((line) => line.slice(Math.min(indentation, line.length)))
    : inner
  return { source: dedented.join('\n'), lineMap: usableDisplay.lineMap.slice(1, -1) }
}

function displayLinesForBodyLines(
  test: ExtractedTest,
  bodyLines: ReadonlySet<number> | undefined,
  lineMap: readonly FormattedDisplayLine[],
): Set<number> | undefined {
  if (!bodyLines?.size) return undefined
  const bodyStartLine = testBodyLine(test)
  const sourceLines = new Set([...bodyLines].map((line) => bodyStartLine + line - 1))
  const displayLines = new Set<number>()
  lineMap.forEach((mapping, index) => {
    if (mapping.sourceLines.some((line) => sourceLines.has(line))) displayLines.add(index + 1)
  })
  return displayLines.size ? displayLines : undefined
}

function firstMappedSourceLine(lineMap: readonly FormattedDisplayLine[]): number | null {
  return lineMap[0]?.sourceLine ?? null
}

function sourceBelongsToTestBody(test: ExtractedTest, sourceFile: string, source: ReadableSource): boolean {
  if (source.file !== sourceFile) return false
  const bodyLine = testBodyLine(test)
  const bodyEndLine = bodyLine + Math.max(test.bodySource.split('\n').length - 1, 0)
  return source.startLine >= bodyLine && source.endLine <= bodyEndLine
}

function testBodyLine(test: ExtractedTest): number {
  return test.bodyLine ?? test.line
}

function shortSourceLabel(file: string, startLine: number, endLine: number): string {
  const parts = file.split(/[\\/]/)
  const shortFile = parts.slice(-2).join('/')
  const line = startLine === endLine ? `L${startLine}` : `L${startLine}–${endLine}`
  return `${shortFile}:${line}`
}
