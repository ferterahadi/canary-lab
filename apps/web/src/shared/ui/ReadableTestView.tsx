import { useEffect, useState } from 'react'
import type {
  ReadableSource,
  ReadableStoryFlowKind,
  ReadableStoryItem,
  ReadableStoryRole,
  ReadableStorySpan,
  ReadableTest,
} from '../api/types'
import { useTheme } from '../lib/theme'
import { codeThemeFor, getCodeHighlighter } from './code-highlighter'
import { storyLocalSequenceLabel, storySequenceLabel } from './readable-story-sequence'

export interface ReadableSourceSelection {
  id: string
  source: ReadableSource
}

// English mode is one source-ordered test story. The role label remains on
// every line, so setup/action/check meaning stays visible without moving steps
// away from their authored execution position.
export function ReadableTestView({
  test,
  sourceFile,
  selectedNodeId,
  onSourceSelect,
}: {
  test: ReadableTest
  sourceFile?: string
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  const canvas = useCodeThemeColors()
  const steps = test.story?.steps ?? []

  return (
    <div
      data-testid="readable-test-story"
      className="shiki-block cl-code-shell overflow-hidden rounded-md text-[11px]"
    >
      <div className="cl-readable-body" style={{ backgroundColor: canvas.bg, color: canvas.fg }}>
        {steps.length ? (
          <StorySequence
            steps={steps}
            sourceFile={sourceFile}
            selectedNodeId={selectedNodeId}
            onSourceSelect={onSourceSelect}
          />
        ) : (
          <span data-testid="readable-test-empty" className="block px-2" style={{ color: 'var(--text-muted)' }}>
            No readable steps found in this test body.
          </span>
        )}
      </div>
    </div>
  )
}

function StorySequence({
  steps,
  parentSequence = [],
  sourceFile,
  selectedNodeId,
  onSourceSelect,
}: {
  steps: ReadableStoryItem[]
  parentSequence?: number[]
  sourceFile?: string
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  const nested = parentSequence.length > 0
  return (
    <ol
      {...(!nested ? { 'data-testid': 'readable-test-sequence' } : {})}
      className="m-0 flex list-none flex-col p-0"
      style={nested ? {
        marginLeft: '1.25rem',
        borderLeft: '1px solid var(--border-default)',
      } : undefined}
    >
      {steps.map((step, index) => (
        <StoryRow
          key={step.id}
          step={step}
          sequence={[...parentSequence, index + 1]}
          sourceFile={sourceFile}
          selectedNodeId={selectedNodeId}
          onSourceSelect={onSourceSelect}
        />
      ))}
    </ol>
  )
}

function StoryRow({
  step,
  sequence,
  sourceFile,
  selectedNodeId,
  onSourceSelect,
}: {
  step: ReadableStoryItem
  sequence: number[]
  sourceFile?: string
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  const fileNote = sourceFile && step.source.file !== sourceFile ? fileName(step.source.file) : undefined
  const sequenceLabel = storySequenceLabel(sequence)
  const localSequenceLabel = storyLocalSequenceLabel(sequence)
  const keyword = storyKeyword(step)
  const selected = selectedNodeId === step.id
  return (
    <li
      data-story-role={step.role}
      data-story-sequence={sequenceLabel}
      data-story-depth={sequence.length - 1}
      {...(step.kind === 'flow' ? { 'data-story-flow': step.flowKind } : {})}
    >
      <button
        type="button"
        data-testid={`readable-story-item-${step.id}`}
        data-fidelity={step.fidelity}
        aria-pressed={selected}
        aria-label={`${sequenceLabel}. ${keyword}: ${step.text}. Show ${sourceLabel(step.source)}`}
        title={`Step ${sequenceLabel} — ${sourceLabel(step.source)} — ${fidelityTitle(step.fidelity)}`}
        onClick={() => onSourceSelect?.({ id: step.id, source: step.source })}
        className="grid w-full grid-cols-[2ch_8ch_minmax(0,1fr)] items-start gap-x-2 px-2 py-0 text-left leading-[1.65] transition-colors hover:bg-running/10"
        style={{
          background: selected ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : undefined,
          boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined,
        }}
      >
        <span
          aria-hidden="true"
          data-story-local-sequence={localSequenceLabel}
          className="text-right tabular-nums"
          style={{ color: 'var(--text-muted)' }}
        >
          {localSequenceLabel}
        </span>
        <span
          data-testid={`readable-story-role-${step.id}`}
          style={{ color: storyKeywordColor(step), fontWeight: 600 }}
        >
          {keyword}
        </span>
        <span className="min-w-0 whitespace-pre-wrap break-words">
          {step.spans.map((span, index) => <StorySpan key={index} span={span} />)}
          {fileNote && <span style={{ color: 'var(--text-muted)' }}> {`// ${fileNote}`}</span>}
        </span>
      </button>
      {step.kind === 'flow' && step.children.length > 0 && (
        <StorySequence
          steps={step.children}
          parentSequence={sequence}
          sourceFile={sourceFile}
          selectedNodeId={selectedNodeId}
          onSourceSelect={onSourceSelect}
        />
      )}
    </li>
  )
}

function StorySpan({ span }: { span: ReadableStorySpan }) {
  return (
    <span
      data-story-span={span.kind ?? 'text'}
      style={{ color: storySpanColor(span.kind) }}
    >
      {span.text}
    </span>
  )
}

const STORY_SPAN_COLORS: Record<NonNullable<ReadableStorySpan['kind']>, string> = {
  variable: 'var(--code-variable)',
  literal: 'var(--code-literal)',
  number: 'var(--code-number)',
  operator: 'var(--code-operator)',
  keyword: 'var(--code-keyword)',
  verb: 'var(--code-function)',
}

function storySpanColor(kind: ReadableStorySpan['kind']): string | undefined {
  return kind ? STORY_SPAN_COLORS[kind] : undefined
}

function roleColor(role: ReadableStoryRole): string {
  if (role === 'setup') return 'var(--code-cyan)'
  if (role === 'action') return 'var(--code-keyword)'
  return 'var(--semantic-attention)'
}

function storyKeywordColor(step: ReadableStoryItem): string {
  if (step.kind !== 'flow') return roleColor(step.role)
  if (step.flowKind === 'catch') return 'var(--semantic-attention)'
  return step.role === 'setup' ? 'var(--code-cyan)' : 'var(--code-keyword)'
}

function storyKeyword(step: ReadableStoryItem): string {
  if (step.kind !== 'flow') return roleLabel(step.role)
  const keywords: Record<ReadableStoryFlowKind, string> = {
    scope: roleLabel(step.role),
    condition: 'IF',
    then: 'THEN',
    otherwise: 'OTHERWISE',
    switch: 'SWITCH',
    case: 'WHEN',
    loop: 'REPEAT',
    retry: 'RETRY',
    try: 'TRY',
    catch: 'ON ERROR',
    finally: 'ALWAYS',
  }
  return keywords[step.flowKind]
}

function roleLabel(role: ReadableStoryRole): 'SETUP' | 'ACTION' | 'CHECK' {
  if (role === 'setup') return 'SETUP'
  if (role === 'action') return 'ACTION'
  return 'CHECK'
}

/** The Shiki theme's canvas colours, shared with Code mode. Until Shiki is
 * ready, the same shell tokens provide the initial background and foreground. */
function useCodeThemeColors(): { bg: string; fg: string } {
  const { resolved } = useTheme()
  const [canvas, setCanvas] = useState<{ bg: string; fg: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    getCodeHighlighter()
      .then((highlighter) => {
        if (cancelled) return
        const colors = highlighter.themeColors(codeThemeFor(resolved))
        setCanvas({ bg: colors.bg ?? 'var(--bg-input)', fg: colors.fg ?? 'var(--text-primary)' })
      })
      .catch(() => { if (!cancelled) setCanvas(null) })
    return () => { cancelled = true }
  }, [resolved])
  return canvas ?? { bg: 'var(--bg-input)', fg: 'var(--text-primary)' }
}

function fidelityTitle(fidelity: ReadableStoryItem['fidelity']): string {
  if (fidelity === 'exact') return 'Original wording written in the test'
  return 'Deterministically described from source code'
}

function fileName(file: string): string {
  return file.replace(/^.*[\\/]/, '')
}

function sourceLabel(source: ReadableSource): string {
  const line = source.startLine === source.endLine
    ? `L${source.startLine}`
    : `L${source.startLine}–${source.endLine}`
  return `${fileName(source.file)}:${line}`
}
