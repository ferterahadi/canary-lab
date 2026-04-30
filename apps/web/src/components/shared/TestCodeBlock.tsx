import { useEffect, useState } from 'react'
import { useTheme } from '../../lib/theme'
import type { ExtractedStep } from '../../api/types'
import { colorClassForStatus, type StepStatus } from '../../lib/test-step-status'

type Highlighter = { codeToHtml: (code: string, opts: { lang: string; theme: string }) => string }
let highlighterPromise: Promise<Highlighter> | null = null
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }, ts, dark, light, wasm] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/themes/one-dark-pro.mjs'),
        import('shiki/themes/one-light.mjs'),
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

// Renders syntax-highlighted code using Shiki. The `source` prop comes from
// the feature's own spec files (server-side AST extraction), not untrusted
// user input, so innerHTML is safe here.
export function ShikiCode({ source }: { source: string }) {
  const { resolved } = useTheme()
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const themeName = resolved === 'dark' ? 'one-dark-pro' : 'one-light'
    getHighlighter().then((hl) => {
      if (cancelled) return
      try {
        setHtml(hl.codeToHtml(source, { lang: 'typescript', theme: themeName }))
      } catch {
        setHtml(null)
      }
    }).catch(() => { if (!cancelled) setHtml(null) })
    return () => { cancelled = true }
  }, [source, resolved])

  if (html === null) {
    return (
      <pre className="overflow-hidden whitespace-pre-wrap break-words rounded p-2 text-[11px]" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
        <code>{source}</code>
      </pre>
    )
  }
  return (
    <div
      className="shiki-block overflow-hidden rounded text-[11px]"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function StatusPill({ status }: { status: StepStatus }) {
  return (
    <span className="rounded border border-current px-1.5 py-0.5 text-[9px] uppercase tracking-wide opacity-80" style={{ fontFamily: 'var(--font-mono)' }}>
      {status}
    </span>
  )
}

export function StepBlock({ step, status, depth }: { step: ExtractedStep; status: StepStatus; depth: number }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <li className={`rounded border ${colorClassForStatus(status)} p-1.5`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs"
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ color: 'var(--text-muted)' }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ color: 'var(--text-primary)' }}>{step.label}</span>
        <span className="ml-auto text-[10px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>L{step.line}</span>
      </button>
      {expanded && step.bodySource && (
        <div className="mt-1.5">
          <ShikiCode source={step.bodySource} />
        </div>
      )}
      {step.children.length > 0 && (
        <ul className="mt-1.5 space-y-1.5 pl-3" style={{ borderLeft: '1px solid var(--border-default)' }}>
          {step.children.map((child, i) => (
            <StepBlock key={`${child.line}:${i}`} step={child} status={status} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}
