import { useEffect, useState } from 'react'
import * as api from '../../../../shared/api/client'
import type { DraftRecord } from '../../../../shared/api/types'
import { AgentSessionView } from '../../../agent-sessions/components/AgentSessionView'
import { ExternalDraftAgentPanel } from '../../../runs/components/ExternalDraftAgentPanel'
import { useTheme } from '../../../../shared/lib/theme'

interface Props {
  draft: DraftRecord
  featureName: string
  onAccept: () => void
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
  onReject,
  onRetry,
  onCancelGeneration,
  acting,
}: Props) {
  const { status } = draft
  const generationActive = status === 'planning' || status === 'generating'
  const visibleFiles = (draft.generatedFiles ?? []).filter((file) => file.endsWith('.spec.ts'))
  const bodyClassName = status === 'generating'
    ? 'flex-1 min-h-0 overflow-hidden p-6'
    : 'flex-1 min-h-0 overflow-y-auto p-6'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={bodyClassName}>
        <div className={`mx-auto max-w-3xl ${status === 'generating' ? 'flex h-full min-h-0 flex-col gap-4' : 'space-y-5'}`}>
          {status === 'generating' && (
            draft.producer === 'external' ? (
              <div className="cl-frame flex min-h-0 flex-1 flex-col overflow-hidden">
                <ExternalDraftAgentPanel draft={draft} stageView="generating" />
              </div>
            ) : (
              <>
                <div
                  className="flex items-center justify-between gap-3 p-3"
                  style={{
                    border: '1px solid var(--border-default)',
                    background: 'var(--bg-overlay)',
                    color: 'var(--text-secondary)',
                    borderRadius: 6,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                  }}
                >
                  <span>Agent is generating the spec files…</span>
                  <button
                    type="button"
                    onClick={onCancelGeneration}
                    disabled={acting}
                    className="cl-button px-2 py-1 disabled:opacity-50"
                    style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                  >
                    {acting ? 'Stopping…' : 'Stop generation'}
                  </button>
                </div>
                <div className="cl-frame flex min-h-0 flex-1 flex-col overflow-hidden">
                  <AgentSessionView source={{ kind: 'draft', draftId: draft.draftId, stage: 'generating', live: true }} />
                </div>
              </>
            )
          )}

          {status === 'error' && (
            <div
              className="p-3 text-xs"
              style={{
                border: '1px solid var(--danger)',
                background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                color: 'var(--danger)',
                borderRadius: 6,
                fontFamily: 'var(--font-mono)',
              }}
            >
              <div className="mb-2 font-semibold">Spec generation failed.</div>
              <div className="text-[11px] opacity-90">{draft.errorMessage ?? 'Unknown error'}</div>
            </div>
          )}

          {status === 'cancelled' && (
            <>
              <div
                className="p-3 text-xs"
                style={{
                  border: '1px solid var(--warning)',
                  background: 'color-mix(in srgb, var(--warning) 10%, transparent)',
                  color: 'var(--warning)',
                  borderRadius: 6,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <div className="mb-2 font-semibold">Generation stopped.</div>
                <div className="text-[11px] opacity-90">{draft.errorMessage ?? 'Generation cancelled by user'}</div>
              </div>
              {draft.producer === 'external' ? (
                <div className="cl-frame flex min-h-[24rem] max-h-[min(70vh,44rem)] flex-col overflow-hidden">
                  <ExternalDraftAgentPanel draft={draft} stageView="generating" />
                </div>
              ) : (
                <div className="cl-frame flex min-h-[24rem] max-h-[min(70vh,44rem)] flex-col overflow-hidden">
                  <AgentSessionView source={{ kind: 'draft', draftId: draft.draftId, stage: draft.activeAgentStage ?? 'generating' }} />
                </div>
              )}
            </>
          )}

          {(status === 'spec-ready' || status === 'accepted') && (
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Generated spec files
              </div>
              <p className="mt-1 mb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                Files will be written under{' '}
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                  features/{featureName}/
                </span>
              </p>
              <FileList
                draftId={draft.draftId}
                files={visibleFiles}
                featureName={featureName}
                refreshKey={draft.updatedAt}
              />
            </div>
          )}
        </div>
      </div>

      <div className="cl-panel-footer flex items-center justify-end gap-2 px-6 py-3">
        {status === 'cancelled' ? (
          <>
            <button
              type="button"
              onClick={onReject}
              disabled={acting || generationActive}
              className="cl-button px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onRetry}
              disabled={acting}
              className="cl-button-primary px-3 py-1.5 disabled:opacity-50"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onReject}
              disabled={acting || generationActive}
              className="cl-button px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={onAccept}
              disabled={acting || status !== 'spec-ready'}
              className="cl-button-primary px-4 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
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
}: {
  draftId: string
  files: string[]
  featureName: string
  refreshKey: string
}) {
  if (files.length === 0) {
    return (
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        No spec files generated.
      </div>
    )
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
}: {
  draftId: string
  path: string
  featureName: string
  refreshKey: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <li
      style={{
        border: '1px solid var(--border-default)',
        background: 'var(--bg-surface)',
        borderRadius: 6,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left font-mono text-[11px]"
        style={{ color: 'var(--text-primary)' }}
      >
        <span>features/{featureName}/{path}</span>
        <span style={{ color: 'var(--accent)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <FilePreview
          draftId={draftId}
          path={path}
          refreshKey={refreshKey}
        />
      )}
    </li>
  )
}

function FilePreview({
  draftId,
  path,
  refreshKey,
}: {
  draftId: string
  path: string
  refreshKey: string
}) {
  const { resolved } = useTheme()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)

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
    return (
      <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--danger)' }}>
        Failed to load: {error}
      </div>
    )
  }
  if (content === null) {
    return (
      <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        Loading…
      </div>
    )
  }
  if (html !== null) {
    return (
      <div className="relative">
        <div
          className="overflow-x-auto px-3 py-2 text-[11px]"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    )
  }
  return (
    <div className="relative">
      <pre
        className="overflow-x-auto px-3 py-2 font-mono text-[11px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        <code>{content}</code>
      </pre>
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
