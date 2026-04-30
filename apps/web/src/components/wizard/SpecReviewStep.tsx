import { useEffect, useState } from 'react'
import * as api from '../../api/client'
import type { DraftRecord } from '../../api/types'
import { AgentLogPanel } from './AgentLogPanel'

interface Props {
  draft: DraftRecord
  featureName: string
  onAccept: () => void
  onReject: () => void
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
  onReject,
  acting,
}: Props): JSX.Element {
  const { status } = draft

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {status === 'generating' && (
            <>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-300">
                Agent is generating the spec files…
              </div>
              <AgentLogPanel draftId={draft.draftId} initialBuffer={draft.specAgentLogTail} />
            </>
          )}

          {status === 'error' && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              <div className="mb-2 font-medium">Spec generation failed.</div>
              <div className="font-mono text-[11px]">{draft.errorMessage ?? 'Unknown error'}</div>
            </div>
          )}

          {(status === 'spec-ready' || status === 'accepted') && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
                Generated files
              </div>
              <p className="mb-2 text-xs text-zinc-500">
                Files will be written under <span className="font-mono">features/{featureName}/</span>.
              </p>
              <FileList
                draftId={draft.draftId}
                files={draft.generatedFiles ?? []}
                featureName={featureName}
              />
            </div>
          )}

          {(status === 'spec-ready' || status === 'accepted') && (
            <details className="rounded border border-zinc-800">
              <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-400">
                Agent output
              </summary>
              <div className="px-3 pb-3">
                <AgentLogPanel draftId={draft.draftId} initialBuffer={draft.specAgentLogTail} />
              </div>
            </details>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-6 py-3">
        <button
          type="button"
          onClick={onReject}
          disabled={acting}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
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
      </div>
    </div>
  )
}

function FileList({
  draftId,
  files,
  featureName,
}: {
  draftId: string
  files: string[]
  featureName: string
}): JSX.Element {
  if (files.length === 0) {
    return <div className="text-xs italic text-zinc-500">No files generated.</div>
  }
  return (
    <ul className="space-y-2">
      {files.map((f) => (
        <FileItem key={f} draftId={draftId} path={f} featureName={featureName} />
      ))}
    </ul>
  )
}

function FileItem({
  draftId,
  path,
  featureName,
}: {
  draftId: string
  path: string
  featureName: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left font-mono text-[11px] text-zinc-300 hover:bg-zinc-900/80"
      >
        <span>features/{featureName}/{path}</span>
        <span className="text-[10px] text-zinc-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && <FilePreview draftId={draftId} path={path} />}
    </li>
  )
}

function FilePreview({ draftId, path }: { draftId: string; path: string }): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
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
  }, [draftId, path])

  useEffect(() => {
    if (content === null) return
    let cancelled = false
    const lang = pickLang(path)
    if (lang === null) {
      setHtml(null)
      return
    }
    getHighlighter()
      .then((hl) => {
        if (cancelled) return
        try {
          setHtml(hl.codeToHtml(content, { lang, theme: 'github-dark' }))
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
  }, [content, path])

  if (error) {
    return <div className="px-3 py-2 text-[11px] text-rose-300">Failed to load: {error}</div>
  }
  if (content === null) {
    return <div className="px-3 py-2 text-[11px] text-zinc-500">Loading…</div>
  }
  if (html !== null) {
    return (
      <div
        className="overflow-x-auto px-3 py-2 text-[11px]"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  return (
    <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] text-zinc-300">
      <code>{content}</code>
    </pre>
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
      const [{ createHighlighterCore }, { createOnigurumaEngine }, ts, dark, wasm] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/themes/github-dark.mjs'),
        import('shiki/wasm'),
      ])
      const hl = await createHighlighterCore({
        themes: [dark.default],
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
