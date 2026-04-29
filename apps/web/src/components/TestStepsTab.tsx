import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type {
  ExtractedStep,
  ExtractedTest,
  FeatureSpecFile,
  RunSummary,
} from '../api/types'
import {
  colorClassForStatus,
  statusForTest,
  type StepStatus,
} from '../lib/test-step-status'

interface Props {
  feature: string
  summary: RunSummary | undefined
}

// Test steps tab — renders the AST-extracted `test()` blocks for the given
// feature, with `test.step()` children indented underneath. Each step's body
// is collapsed by default; click to expand and see the syntax-highlighted
// source. Final-state coloring comes from the per-test summary; per-step
// granularity is a follow-up slice (see plan).
export function TestStepsTab({ feature, summary }: Props): JSX.Element {
  const [specs, setSpecs] = useState<FeatureSpecFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSpecs(null)
    setError(null)
    api.getFeatureTests(feature)
      .then((data) => {
        if (cancelled) return
        setSpecs(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [feature])

  if (error) {
    return <div className="p-4 text-sm text-rose-400">Failed to load tests: {error}</div>
  }
  if (!specs) {
    return <div className="p-4 text-sm text-zinc-500">Loading test steps…</div>
  }
  if (specs.length === 0) {
    return <div className="p-4 text-sm text-zinc-500">No spec files in this feature.</div>
  }

  return (
    <div className="overflow-y-auto p-4 text-sm">
      {specs.map((spec) => (
        <div key={spec.file} className="mb-6">
          <h3 className="mb-2 font-mono text-[11px] text-zinc-500">{spec.file}</h3>
          {spec.parseError && (
            <div className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-[11px] text-rose-300">
              Parse error: {spec.parseError}
            </div>
          )}
          {spec.tests.length === 0 ? (
            <div className="text-xs text-zinc-500">No tests found.</div>
          ) : (
            <ul className="space-y-2">
              {spec.tests.map((t) => (
                <TestBlock key={`${spec.file}:${t.line}`} test={t} summary={summary} />
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function TestBlock({ test, summary }: { test: ExtractedTest; summary: RunSummary | undefined }): JSX.Element {
  const status = statusForTest(test.name, summary)
  return (
    <li className={`rounded border ${colorClassForStatus(status)} p-2`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-100">{test.name}</span>
        <StatusPill status={status} />
      </div>
      {test.steps.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-l border-zinc-800 pl-3">
          {test.steps.map((s, i) => (
            <StepBlock key={`${s.line}:${i}`} step={s} status={status} depth={0} />
          ))}
        </ul>
      )}
    </li>
  )
}

function StepBlock({ step, status, depth }: { step: ExtractedStep; status: StepStatus; depth: number }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <li className={`rounded border ${colorClassForStatus(status)} p-1.5`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-zinc-500">{expanded ? '▾' : '▸'}</span>
        <span className="text-zinc-200">{step.label}</span>
        <span className="ml-auto font-mono text-[10px] text-zinc-600">L{step.line}</span>
      </button>
      {expanded && step.bodySource && (
        <div className="mt-1.5">
          <ShikiCode source={step.bodySource} />
        </div>
      )}
      {step.children.length > 0 && (
        <ul className="mt-1.5 space-y-1.5 border-l border-zinc-800 pl-3">
          {step.children.map((child, i) => (
            <StepBlock key={`${child.line}:${i}`} step={child} status={status} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

function StatusPill({ status }: { status: StepStatus }): JSX.Element {
  return (
    <span className="rounded border border-current px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide opacity-80">
      {status}
    </span>
  )
}

// Lazy-load Shiki the first time a code block expands. We import only the
// minimal core engine plus the typescript grammar and github-dark theme so
// the rest of Shiki's grammar bundles aren't pulled into the build. The
// resulting highlighter is cached at module scope so subsequent expansions
// don't re-import the wasm bundle.
type Highlighter = { codeToHtml: (code: string, opts: { lang: string; theme: string }) => string }
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

function ShikiCode({ source }: { source: string }): JSX.Element {
  // Shiki is the source of the rendered HTML; the input `source` comes from
  // the feature's own spec files (server-side AST extraction). No untrusted
  // user input flows into this path. dangerouslySetInnerHTML is required
  // because Shiki's only output format is HTML.
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getHighlighter().then((hl) => {
      if (cancelled) return
      try {
        setHtml(hl.codeToHtml(source, { lang: 'typescript', theme: 'github-dark' }))
      } catch {
        setHtml(null)
      }
    }).catch(() => { if (!cancelled) setHtml(null) })
    return () => { cancelled = true }
  }, [source])

  if (html === null) {
    return (
      <pre className="overflow-x-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">
        <code>{source}</code>
      </pre>
    )
  }
  return (
    <div
      className="overflow-x-auto rounded bg-zinc-950 p-2 text-[11px] [&_pre]:bg-transparent [&_pre]:!m-0"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
