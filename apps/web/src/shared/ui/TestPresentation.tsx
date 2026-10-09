import { TestLanguageSwitch } from './TestLanguageSwitch'
import { useMemo, useState } from 'react'
import type { FormattedDisplayLine } from '@shared/code-display-format'
import type { ExtractedTest } from '@shared/extracted-test'
import { storyCodeLineNumbers, storyItemIdForSourceLine } from '@shared/readable-tests/story-source-map'
import {
  bodyLineForSourceLine,
  buildTestViewRows,
  markedRowIndexes,
  sourceLineForBodyLine,
  storyChangeMarks,
  testViewSource,
} from '@shared/test-view/render-model'
import type { TestExecutionLineHighlight } from '@/features/runs/utils/test-step-status'
import { ReadableTestView, type ReadableSourceSelection } from './ReadableTestView'
import { ShikiCode, SourceOpenShell } from './TestCodeBlock'

type PresentationMode = 'english' | 'code'

export function TestPresentation({
  test,
  sourceFile,
  executionHighlight,
  changedLines: suppliedChangedLines,
  showOpenButton = true,
}: {
  test: ExtractedTest
  sourceFile: string
  executionHighlight?: TestExecutionLineHighlight | null
  changedLines?: Set<number>
  showOpenButton?: boolean
}) {
  const changedLines = useMemo(() => suppliedChangedLines ?? (test.sourceChanges
    ? new Set(test.sourceChanges.changedLines.map((line) => bodyLineForSourceLine(test, line)))
    : undefined), [suppliedChangedLines, test])
  const [mode, setMode] = useState<PresentationMode>('english')
  const [selectedSource, setSelectedSource] = useState<ReadableSourceSelection | null>(null)

  const selectSource = (selection: ReadableSourceSelection) => {
    setSelectedSource(selection)
    setMode('code')
  }
  const code = testViewSource(test, sourceFile, selectedSource?.source)
  const visibleRange = selectedSource?.source ?? code
  const fullTestRange = testViewSource(test, sourceFile, undefined)
  const rows = buildTestViewRows({
    test,
    sourceFile,
    selectedSource: selectedSource?.source,
    execution: executionHighlight ?? undefined,
    changedBodyLines: changedLines,
  })
  const displayedExecutionLines = markedRowIndexes(rows, (marks) => marks.execution !== undefined)
  const displayedChangedLines = markedRowIndexes(rows, (marks) => marks.changed)
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
    ? sourceLineForBodyLine(test, executionHighlight.bodyLine)
    : undefined
  const executionStoryNodeId = executionSourceLine == null || !test.readable.story
    ? undefined
    : storyItemIdForSourceLine(test.readable.story.steps, sourceFile, executionSourceLine)
  const changedStory = useMemo(() => storyChangeMarks(test, sourceFile, changedLines), [changedLines, sourceFile, test])

  return (
    <div data-testid="test-presentation">
      <div className="mb-2 flex min-w-0 items-center gap-2 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <TestLanguageSwitch mode={mode} onChange={setMode} />
        {mode === 'english' && test.readable.completeness === 'partial' && (
          <span className="min-w-0 truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
            English representation is incomplete
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
          {changedStory.unmappedSourceLines.length > 0 && (
            <div
              data-testid="readable-unmapped-change"
              className="mb-2 flex items-start gap-2 rounded-md border px-2 py-1.5 text-[10px]"
              style={{
                color: 'var(--danger)',
                borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))',
                background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
              }}
            >
              <span className="min-w-0 flex-1">
                Modified source at {formatSourceLines(changedStory.unmappedSourceLines)} has no executable English step. This includes changes such as a check being commented out.
              </span>
              <button
                type="button"
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={() => setMode('code')}
              >
                View exact diff
              </button>
            </div>
          )}
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
              changedNodeIds={changedStory.nodeIds}
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

function formatSourceLines(lines: readonly number[]): string {
  return lines.map((line) => `L${line}`).join(', ')
}

function firstMappedSourceLine(lineMap: readonly FormattedDisplayLine[]): number | null {
  return lineMap[0]?.sourceLine ?? null
}

function shortSourceLabel(file: string, startLine: number, endLine: number): string {
  const parts = file.split(/[\\/]/)
  const shortFile = parts.slice(-2).join('/')
  const line = startLine === endLine ? `L${startLine}` : `L${startLine}–${endLine}`
  return `${shortFile}:${line}`
}
