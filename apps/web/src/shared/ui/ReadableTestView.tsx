import { useEffect, useState } from 'react'
import type {
  ReadableBranchPath,
  ReadableFidelity,
  ReadableNode,
  ReadableSource,
  ReadableTest,
} from '../api/types'
import { useTheme } from '../lib/theme'
import { codeThemeFor, getCodeHighlighter } from './code-highlighter'

export interface ReadableSourceSelection {
  id: string
  source: ReadableSource
}

// The English presentation is the Code view's document with the language
// swapped: the same `cl-code-shell` block, the same Shiki theme canvas
// (background + default text colour), the same 11px mono type, 0.5rem inset,
// and `{ … }` body framing — so toggling modes changes the words, not the
// surface. Translated statements render as plain English lines; statements no
// rule could translate stay as Shiki-highlighted source lines in place.
// Expanded helper bodies stay collapsed here: the call reads as one line
// ("Check successful publish"), the way the code names it.
export function ReadableTestView({
  test,
  sourceFile,
  selectedNodeId,
  onSourceSelect,
}: {
  test: ReadableTest
  /** The file the test itself is defined in. Rows translated from another file
   *  (expanded helper bodies) carry a dim `// file.ts` comment-style suffix. */
  sourceFile?: string
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  const canvas = useCodeThemeColors()
  if (test.nodes.length === 0) {
    return (
      <div className="shiki-block cl-code-shell overflow-hidden rounded-md text-[11px]">
        <div className="cl-readable-body" style={{ backgroundColor: canvas.bg, color: canvas.fg }}>
          <span data-testid="readable-test-empty" className="block px-2" style={{ color: 'var(--text-muted)' }}>
            No executable steps found in this test body.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="shiki-block cl-code-shell overflow-hidden rounded-md text-[11px]">
      <div className="cl-readable-body" style={{ backgroundColor: canvas.bg, color: canvas.fg }}>
        <div aria-hidden="true" className="px-2">{'{'}</div>
        <ol data-testid="readable-test-tree" className="m-0 flex list-none flex-col p-0">
          {test.nodes.map((node) => (
            <ReadableNodeRow
              key={node.id}
              node={node}
              depth={1}
              sourceFile={sourceFile}
              selectedNodeId={selectedNodeId}
              onSourceSelect={onSourceSelect}
            />
          ))}
        </ol>
        <div aria-hidden="true" className="px-2">{'}'}</div>
      </div>
    </div>
  )
}

/** The Shiki theme's own canvas colours — the exact background and default
 *  text colour the Code pane's <pre> paints — so both modes share one surface.
 *  Until the highlighter loads, the shell tokens stand in (the same fallback
 *  Code mode shows before its first highlight). */
function useCodeThemeColors(): { bg: string; fg: string } {
  const { resolved } = useTheme()
  const [canvas, setCanvas] = useState<{ bg: string; fg: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    getCodeHighlighter()
      .then((hl) => {
        if (cancelled) return
        const colors = hl.themeColors(codeThemeFor(resolved))
        setCanvas({ bg: colors.bg ?? 'var(--bg-input)', fg: colors.fg ?? 'var(--text-primary)' })
      })
      .catch(() => { if (!cancelled) setCanvas(null) })
    return () => { cancelled = true }
  }, [resolved])
  return canvas ?? { bg: 'var(--bg-input)', fg: 'var(--text-primary)' }
}

function ReadableNodeRow({
  node,
  depth,
  sourceFile,
  selectedNodeId,
  onSourceSelect,
}: {
  node: ReadableNode
  depth: number
  sourceFile?: string
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  // An expanded helper body stays one line here — the reader asked what the
  // step does, not how the helper does it. The children still exist on the
  // node for consumers that want them (the evaluation flowchart descends).
  const collapsedHelper = node.kind === 'group' && node.origin === 'helper'
  const children = !collapsedHelper && (node.kind === 'group' || node.kind === 'loop') ? node.children : []
  return (
    <li data-readable-kind={node.kind}>
      <ReadableRow
        id={node.id}
        text={node.text}
        fidelity={node.fidelity}
        source={node.source}
        depth={depth}
        sourceFile={sourceFile}
        selected={selectedNodeId === node.id}
        onSourceSelect={onSourceSelect}
      />
      {node.kind === 'branch' ? (
        <ol className="m-0 flex list-none flex-col p-0">
          {node.paths.map((path) => (
            <ReadablePathRow
              key={path.id}
              path={path}
              depth={depth + 1}
              sourceFile={sourceFile}
              selectedNodeId={selectedNodeId}
              onSourceSelect={onSourceSelect}
            />
          ))}
        </ol>
      ) : children.length > 0 ? (
        <ol className="m-0 flex list-none flex-col p-0">
          {children.map((child) => (
            <ReadableNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              sourceFile={sourceFile}
              selectedNodeId={selectedNodeId}
              onSourceSelect={onSourceSelect}
            />
          ))}
        </ol>
      ) : null}
    </li>
  )
}

function ReadablePathRow({
  path,
  depth,
  sourceFile,
  selectedNodeId,
  onSourceSelect,
}: {
  path: ReadableBranchPath
  depth: number
  sourceFile?: string
  selectedNodeId?: string | null
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  return (
    <li data-readable-kind="path">
      <ReadableRow
        id={path.id}
        text={path.text}
        fidelity={path.fidelity}
        source={path.source}
        depth={depth}
        sourceFile={sourceFile}
        selected={selectedNodeId === path.id}
        onSourceSelect={onSourceSelect}
      />
      {path.children.length > 0 && (
        <ol className="m-0 flex list-none flex-col p-0">
          {path.children.map((child) => (
            <ReadableNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              sourceFile={sourceFile}
              selectedNodeId={selectedNodeId}
              onSourceSelect={onSourceSelect}
            />
          ))}
        </ol>
      )}
    </li>
  )
}

function ReadableRow({
  id,
  text,
  fidelity,
  source,
  depth,
  sourceFile,
  selected,
  onSourceSelect,
}: {
  id: string
  text: string
  fidelity: ReadableFidelity
  source: ReadableSource
  depth: number
  sourceFile?: string
  selected: boolean
  onSourceSelect?: (selection: ReadableSourceSelection) => void
}) {
  const fileNote = sourceFile && source.file !== sourceFile ? fileName(source.file) : undefined
  return (
    <button
      type="button"
      data-testid={`readable-node-${id}`}
      data-fidelity={fidelity}
      aria-pressed={selected}
      aria-label={`Show source for ${text}, ${sourceLabel(source)}`}
      title={`${sourceLabel(source)} — ${fidelityTitle(fidelity)}`}
      onClick={() => onSourceSelect?.({ id, source })}
      className="block w-full text-left transition-colors hover:bg-running/10"
      style={{
        // Nesting is literal indentation, the way the source itself indents.
        paddingLeft: `calc(0.5rem + ${depth * 2}ch)`,
        paddingRight: '0.5rem',
        background: selected ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : undefined,
        boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined,
      }}
    >
      {fidelity === 'unresolved' ? (
        <InlineSource id={id} snippet={source.snippet} />
      ) : fidelity === 'exact' ? (
        /* Authored wording is a string literal in the source, so it keeps the
           code themes' string colour. */
        <span style={{ color: 'var(--code-string)' }}>{text}</span>
      ) : (
        <DerivedText text={text} />
      )}
      {fileNote && <span style={{ color: 'var(--text-muted)' }}> {`// ${fileNote}`}</span>}
    </button>
  )
}

/** Derived steps are imperative by construction, so the leading verb (Check,
 *  Send, Open…) is this language's keyword — tinted with the code themes'
 *  keyword purple the way Shiki tints `await`/`const` in Code mode. */
function DerivedText({ text }: { text: string }) {
  const space = text.indexOf(' ')
  if (space < 0) return <span style={{ color: 'var(--code-keyword)' }}>{text}</span>
  return (
    <>
      <span style={{ color: 'var(--code-keyword)' }}>{text.slice(0, space)}</span>
      {text.slice(space)}
    </>
  )
}

/** A statement no translation rule matched, kept as the source line it is —
 *  highlighted by the same shared Shiki instance Code mode uses, so it looks
 *  identical there and here. */
function InlineSource({ id, snippet }: { id: string; snippet: string }) {
  const { resolved } = useTheme()
  const [lines, setLines] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getCodeHighlighter().then((hl) => {
      if (cancelled) return
      try {
        const html = hl.codeToHtml(snippet, { lang: 'typescript', theme: codeThemeFor(resolved) })
        // Keep only the token spans: the outer <pre> carries the Shiki theme's
        // own background, and this line lives on the shared shell's background.
        setLines(/<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? null)
      } catch {
        setLines(null)
      }
    }).catch(() => { if (!cancelled) setLines(null) })
    return () => { cancelled = true }
  }, [snippet, resolved])

  if (lines === null) {
    return (
      <span
        data-testid={`readable-source-${id}`}
        className="block whitespace-pre-wrap break-words"
      >
        {snippet}
      </span>
    )
  }
  return (
    <span
      data-testid={`readable-source-${id}`}
      className="block whitespace-pre-wrap break-words [&_span.line]:block"
      // Shiki has already escaped the snippet it highlighted (the snippet comes
      // from the feature's own spec files, not user input), and the regex above
      // only unwraps Shiki's own <code> element.
      // eslint-disable-next-line no-restricted-syntax
      dangerouslySetInnerHTML={{ __html: lines }}
    />
  )
}

function fidelityTitle(fidelity: ReadableFidelity): string {
  switch (fidelity) {
    case 'exact': return 'Original wording written in the test'
    case 'derived': return 'Deterministically described from source code'
    case 'unresolved': return 'Not translated — the exact source line'
  }
}

function fileName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file
}

function sourceLabel(source: ReadableSource): string {
  const line = source.startLine === source.endLine
    ? `L${source.startLine}`
    : `L${source.startLine}–${source.endLine}`
  return `${fileName(source.file)}:${line}`
}
