import { useMemo, useState } from 'react'
import type { ExtractedTest, ReadableSource } from '../api/types'
import { ReadableTestView, type ReadableSourceSelection } from './ReadableTestView'
import { ShikiCode } from './TestCodeBlock'
import { storyCodeLineNumbers } from './readable-story-sequence'

type PresentationMode = 'english' | 'code'

export function TestPresentation({
  test,
  sourceFile,
  activeLine,
  runningHighlight,
  changedLines,
  showCodeOpenButton = true,
}: {
  test: ExtractedTest
  sourceFile: string
  activeLine?: number | null
  runningHighlight?: boolean
  changedLines?: Set<number>
  showCodeOpenButton?: boolean
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
  const displayedActiveLine = showingFullTest
    ? shiftBodyLine(activeLine, code.hiddenLeadingLines)
    : undefined
  const displayedChangedLines = showingFullTest
    ? shiftBodyLines(changedLines, code.hiddenLeadingLines)
    : undefined
  const storyLineNumbers = useMemo(() => {
    const steps = test.readable.story?.steps
    if (!steps) return undefined
    const visibleLineCount = code.source ? code.source.split('\n').length : 0
    return storyCodeLineNumbers(
      steps,
      code.file,
      code.displayStartLine,
      code.displayStartLine + Math.max(visibleLineCount - 1, 0),
    )
  }, [code.displayStartLine, code.file, code.source, test.readable.story?.steps])

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
          <ReadableTestView
            test={test.readable}
            sourceFile={sourceFile}
            selectedNodeId={selectedSource?.id}
            onSourceSelect={selectSource}
          />
        </div>
      ) : (
        <div data-testid="test-presentation-code">
          {code.source ? (
            <ShikiCode
              source={code.source}
              activeLine={displayedActiveLine}
              sourceLocation={{ file: code.file, startLine: code.displayStartLine }}
              runningHighlight={showingFullTest ? runningHighlight : false}
              changedLines={displayedChangedLines}
              showOpenButton={showCodeOpenButton}
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
  displayStartLine: number
  hiddenLeadingLines: number
} {
  if (selectedSource && !sourceBelongsToTestBody(test, sourceFile, selectedSource)) {
    const display = displayCodeSource(selectedSource.snippet, selectedSource.startLine)
    return {
      source: display.source,
      file: selectedSource.file,
      startLine: selectedSource.startLine,
      endLine: selectedSource.endLine,
      displayStartLine: display.startLine,
      hiddenLeadingLines: display.hiddenLeadingLines,
    }
  }
  const startLine = testBodyLine(test)
  const display = displayCodeSource(test.bodySource, startLine)
  return {
    source: display.source,
    file: sourceFile,
    startLine,
    endLine: startLine + Math.max(test.bodySource.split('\n').length - 1, 0),
    displayStartLine: display.startLine,
    hiddenLeadingLines: display.hiddenLeadingLines,
  }
}

/** Test callback bodies arrive as `{ ... }`. Code mode is already scoped to
 * that body, so showing the wrapper adds two rows that English mode cannot have.
 * Remove only standalone wrapper lines and their shared indentation; source
 * navigation keeps using the original absolute lines. */
function displayCodeSource(
  source: string,
  startLine: number,
): { source: string; startLine: number; hiddenLeadingLines: number } {
  const lines = source.split('\n')
  if (lines.length < 2 || lines[0].trim() !== '{' || lines.at(-1)?.trim() !== '}') {
    return { source, startLine, hiddenLeadingLines: 0 }
  }
  const inner = lines.slice(1, -1)
  const indentation = inner
    .filter((line) => line.trim())
    .reduce((least, line) => Math.min(least, line.match(/^\s*/)?.[0].length ?? 0), Infinity)
  const dedented = Number.isFinite(indentation)
    ? inner.map((line) => line.slice(Math.min(indentation, line.length)))
    : inner
  return { source: dedented.join('\n'), startLine: startLine + 1, hiddenLeadingLines: 1 }
}

function shiftBodyLine(line: number | null | undefined, hiddenLeadingLines: number): number | undefined {
  if (line == null) return undefined
  const shifted = line - hiddenLeadingLines
  return shifted > 0 ? shifted : undefined
}

function shiftBodyLines(lines: Set<number> | undefined, hiddenLeadingLines: number): Set<number> | undefined {
  if (!lines || hiddenLeadingLines === 0) return lines
  return new Set([...lines].map((line) => line - hiddenLeadingLines).filter((line) => line > 0))
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
