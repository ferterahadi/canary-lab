import { useState } from 'react'
import type { ExtractedTest, ReadableSource } from '../api/types'
import { ReadableTestView, type ReadableSourceSelection } from './ReadableTestView'
import { ShikiCode } from './TestCodeBlock'

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
            Some steps stay as source
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
              activeLine={showingFullTest ? activeLine : undefined}
              sourceLocation={{ file: code.file, startLine: code.startLine }}
              runningHighlight={showingFullTest ? runningHighlight : false}
              changedLines={showingFullTest ? changedLines : undefined}
              showOpenButton={showCodeOpenButton}
              selectedSourceRange={selectedSource?.source}
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
): { source: string; file: string; startLine: number; endLine: number } {
  if (selectedSource && !sourceBelongsToTestBody(test, sourceFile, selectedSource)) {
    return {
      source: selectedSource.snippet,
      file: selectedSource.file,
      startLine: selectedSource.startLine,
      endLine: selectedSource.endLine,
    }
  }
  return {
    source: test.bodySource,
    file: sourceFile,
    startLine: testBodyLine(test),
    endLine: testBodyLine(test) + Math.max(test.bodySource.split('\n').length - 1, 0),
  }
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
