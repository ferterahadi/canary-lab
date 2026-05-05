import { useEffect, useRef, useState } from 'react'
import * as api from '../../api/client'
import type { DraftRecord } from '../../api/types'
import { AgentLogPanel } from './AgentLogPanel'
import { useTheme } from '../../lib/theme'

interface Props {
  draft: DraftRecord
  featureName: string
  onAccept: () => void
  onRefine: (input: { path: string; selectedText: string; suggestion: string }) => Promise<void>
  onReject: () => void
  onRetry: () => void
  onCancelGeneration: () => void
  acting: boolean
}

// Step 3: review the generated spec files. While `generating` we show the
// agent's log; on `spec-ready` we render the list of generated file paths
// and let the user expand each to see Shiki-highlighted content (lazy-
// loaded via the same dynamic-import path as TestStepsTab).
export function SpecReviewStep({
  draft,
  featureName,
  onAccept,
  onRefine,
  onReject,
  onRetry,
  onCancelGeneration,
  acting,
}: Props) {
  const { status } = draft
  const generationActive = status === 'planning' || status === 'generating' || status === 'refining'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {(status === 'generating' || status === 'refining') && (
            <>
              <div className="flex items-center justify-between gap-3 rounded border border-zinc-200 bg-zinc-50/60 p-3 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300">
                <span>Agent is {status === 'refining' ? 'applying your refinement' : 'generating the spec files'}...</span>
                <button
                  type="button"
                  onClick={onCancelGeneration}
                  disabled={acting}
                  className="rounded border border-rose-500/40 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-300"
                >
                  {acting ? 'Stopping…' : 'Stop generation'}
                </button>
              </div>
              <AgentLogPanel
                draftId={draft.draftId}
                initialBuffer={status === 'refining' ? draft.refineAgentLogTail : draft.specAgentLogTail}
                agent={draft.wizardAgent}
                phase={status === 'refining' ? 'refining' : 'generating'}
                status="running"
                compact
              />
            </>
          )}

          {status === 'error' && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              <div className="mb-2 font-medium">Spec generation failed.</div>
              <div className="font-mono text-[11px]">{draft.errorMessage ?? 'Unknown error'}</div>
            </div>
          )}

          {status === 'cancelled' && (
            <>
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                <div className="mb-2 font-medium">Generation stopped.</div>
                <div>{draft.errorMessage ?? 'Generation cancelled by user'}</div>
              </div>
              <AgentLogPanel
                draftId={draft.draftId}
                initialBuffer={draft.refineAgentLogTail || draft.specAgentLogTail}
                agent={draft.wizardAgent}
                phase={draft.activeAgentStage ?? 'generating'}
                status="idle"
                compact
              />
            </>
          )}

          {(status === 'spec-ready' || status === 'refining' || status === 'accepted') && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                Generated files
              </div>
              <p className="mb-2 text-xs text-zinc-500">
                Files will be written under <span className="font-mono">features/{featureName}/</span>.
              </p>
              <FileList
                draftId={draft.draftId}
                files={draft.generatedFiles ?? []}
                featureName={featureName}
                refreshKey={draft.updatedAt}
                onRefine={onRefine}
                refining={status === 'refining' || acting}
              />
            </div>
          )}

          {(status === 'spec-ready' || status === 'accepted') && (
            <details className="rounded border border-zinc-200 dark:border-zinc-800">
              <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                Agent output
              </summary>
              <div className="px-3 pb-3">
                <AgentLogPanel
                  draftId={draft.draftId}
                  initialBuffer={draft.specAgentLogTail}
                  agent={draft.wizardAgent}
                  phase="generating"
                  status="idle"
                />
              </div>
            </details>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-6 py-3 dark:border-zinc-800">
        {status === 'cancelled' ? (
          <>
            <button
              type="button"
              onClick={onReject}
              disabled={acting || generationActive}
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onRetry}
              disabled={acting}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-zinc-50 hover:bg-emerald-500 disabled:opacity-50"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onReject}
              disabled={acting}
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={onAccept}
              disabled={acting || status !== 'spec-ready'}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-zinc-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {acting ? 'Working…' : 'Accept & create feature'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function FileList({
  draftId,
  files,
  featureName,
  refreshKey,
  onRefine,
  refining,
}: {
  draftId: string
  files: string[]
  featureName: string
  refreshKey: string
  onRefine: (input: { path: string; selectedText: string; suggestion: string }) => Promise<void>
  refining: boolean
}) {
  if (files.length === 0) {
    return <div className="text-xs italic text-zinc-500">No files generated.</div>
  }
  return (
    <ul className="space-y-2">
      {files.map((f) => (
        <FileItem
          key={f}
          draftId={draftId}
          path={f}
          featureName={featureName}
          refreshKey={refreshKey}
          onRefine={onRefine}
          refining={refining}
        />
      ))}
    </ul>
  )
}

function FileItem({
  draftId,
  path,
  featureName,
  refreshKey,
  onRefine,
  refining,
}: {
  draftId: string
  path: string
  featureName: string
  refreshKey: string
  onRefine: (input: { path: string; selectedText: string; suggestion: string }) => Promise<void>
  refining: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left font-mono text-[11px] text-zinc-700 hover:bg-zinc-100/80 dark:text-zinc-300 dark:hover:bg-zinc-900/80"
      >
        <span>features/{featureName}/{path}</span>
        <span className="text-[10px] text-zinc-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <FilePreview
          draftId={draftId}
          path={path}
          refreshKey={refreshKey}
          onRefine={onRefine}
          refining={refining}
        />
      )}
    </li>
  )
}

function FilePreview({
  draftId,
  path,
  refreshKey,
  onRefine,
  refining,
}: {
  draftId: string
  path: string
  refreshKey: string
  onRefine: (input: { path: string; selectedText: string; suggestion: string }) => Promise<void>
  refining: boolean
}) {
  const { resolved } = useTheme()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)
  const [suggestion, setSuggestion] = useState('')
  const previewRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    api
      .getDraftFile(draftId, path)
      .then((res) => {
        if (cancelled) return
        setContent(res.content)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [draftId, path, refreshKey])

  const captureSelection = (): void => {
    if (refining) return
    const selected = window.getSelection()
    const text = selected?.toString().trim()
    if (!selected || !text || !previewRef.current) {
      setSelection(null)
      return
    }
    const anchor = selected.anchorNode
    if (!anchor || !previewRef.current.contains(anchor)) {
      setSelection(null)
      return
    }
    const range = selected.rangeCount > 0 ? selected.getRangeAt(0) : null
    const rect = range?.getBoundingClientRect()
    setSelection({
      text,
      x: Math.min(rect?.left ?? 24, window.innerWidth - 340),
      y: Math.min((rect?.bottom ?? 120) + 8, window.innerHeight - 90),
    })
    setSuggestion('')
  }

  const submitRefine = async (): Promise<void> => {
    if (!selection || !suggestion.trim()) return
    await onRefine({ path, selectedText: selection.text, suggestion: suggestion.trim() })
    setSelection(null)
    setSuggestion('')
  }

  useEffect(() => {
    if (content === null) return
    let cancelled = false
    const lang = pickLang(path)
    if (lang === null) {
      setHtml(null)
      return
    }
    const themeName = resolved === 'dark' ? 'github-dark' : 'github-light'
    getHighlighter()
      .then((hl) => {
        if (cancelled) return
        try {
          setHtml(hl.codeToHtml(content, { lang, theme: themeName }))
        } catch {
          setHtml(null)
        }
      })
      .catch(() => {
        if (!cancelled) setHtml(null)
      })
    return () => {
      cancelled = true
    }
  }, [content, path, resolved])

  if (error) {
    return <div className="px-3 py-2 text-[11px] text-rose-300">Failed to load: {error}</div>
  }
  if (content === null) {
    return <div className="px-3 py-2 text-[11px] text-zinc-500">Loading…</div>
  }
  if (html !== null) {
    return (
      <div ref={previewRef} onMouseUp={captureSelection} className="relative">
        <div
          className="overflow-x-auto px-3 py-2 text-[11px]"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {selection && (
          <RefinePopover
            x={selection.x}
            y={selection.y}
            suggestion={suggestion}
            disabled={refining}
            onChange={setSuggestion}
            onSubmit={submitRefine}
            onCancel={() => setSelection(null)}
          />
        )}
      </div>
    )
  }
  return (
    <div ref={previewRef} onMouseUp={captureSelection} className="relative">
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
        <code>{content}</code>
      </pre>
      {selection && (
        <RefinePopover
          x={selection.x}
          y={selection.y}
          suggestion={suggestion}
          disabled={refining}
          onChange={setSuggestion}
          onSubmit={submitRefine}
          onCancel={() => setSelection(null)}
        />
      )}
    </div>
  )
}

function RefinePopover({
  x,
  y,
  suggestion,
  disabled,
  onChange,
  onSubmit,
  onCancel,
}: {
  x: number
  y: number
  suggestion: string
  disabled: boolean
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="fixed z-[70] w-80 rounded border border-zinc-300 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-950"
      style={{ left: x, top: y }}
    >
      <input
        autoFocus
        value={suggestion}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void onSubmit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Suggest an adjustment and press Enter"
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />
    </div>
  )
}

function pickLang(filePath: string): 'typescript' | 'javascript' | null {
  if (filePath.endsWith('.cjs') || filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
    return 'javascript'
  }
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    return 'typescript'
  }
  return null
}

// Lazy Shiki — same dynamic-import pattern as TestStepsTab. The highlighter
// loads the typescript grammar and github-dark theme. JS files reuse the TS
// grammar (Shiki's typescript covers a strict superset of JS for our use).
type Highlighter = {
  codeToHtml: (code: string, opts: { lang: string; theme: string }) => string
}
let highlighterPromise: Promise<Highlighter> | null = null
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }, ts, dark, light, wasm] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/themes/github-dark.mjs'),
        import('shiki/themes/github-light.mjs'),
        import('shiki/wasm'),
      ])
      const hl = await createHighlighterCore({
        themes: [dark.default, light.default],
        langs: [ts.default],
        engine: createOnigurumaEngine(wasm.default),
      })
      return {
        codeToHtml: (code, opts) => hl.codeToHtml(code, opts),
      }
    })()
  }
  return highlighterPromise
}
