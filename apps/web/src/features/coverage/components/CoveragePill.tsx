import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import * as api from '../../../shared/api/client'
import type { CoverageJobIndexEntry } from '../../../shared/api/types'
import { StatusDot } from '../../config/components/atoms'

// Coverage pill (R7): an ALWAYS-VISIBLE launcher. Idle, it's a neutral "Coverage"
// launcher; while a coverage/summary job runs it takes the in-flight treatment
// (pulsing dot + label). Clicking opens a feature picker dialog that mirrors the
// Portify picker — every feature listed with its coverage status, click resumes
// where you left off (opens that feature's coverage ledger).
export function CoveragePill({
  jobs,
  features,
  onOpenFeature,
}: {
  jobs: CoverageJobIndexEntry[]
  features: { name: string }[]
  onOpenFeature: (feature: string) => void
}) {
  const [open, setOpen] = useState(false)

  const running = jobs.filter((j) => j.status === 'running')

  const label = running.length === 0
    ? 'Coverage'
    : running.length === 1
      ? `Coverage · ${running[0].kind === 'summary' ? 'summarizing' : 'mapping'}`
      : `Coverage · ${running.length} running`

  return (
    <div className="shrink-0" data-testid="coverage-pill">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="Coverage"
        title={running.length ? running.map((j) => `${j.feature}: ${j.kind} generating…`).join('\n') : 'Verified Coverage — open a feature ledger or watch background tasks'}
        className="cl-button flex items-center gap-1.5 px-2.5 py-1"
        style={running.length ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border-default))' } : undefined}
      >
        {running.length ? (
          <StatusDot state="running" className="shrink-0" />
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="4.5" />
            <circle cx="12" cy="12" r="0.6" fill="currentColor" />
          </svg>
        )}
        <span style={{ fontSize: 12, fontWeight: 500, color: running.length ? 'var(--accent)' : undefined }}>{label}</span>
      </button>
      {open && (
        <CoveragePickerDialog
          features={features}
          jobs={jobs}
          onPick={(f) => { setOpen(false); onOpenFeature(f) }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

// Tone for a coverage headline — reused from the ledger's HeadlinePill so a colour
// means the same thing everywhere (green covered, sky generating, amber stale).
function headlineTone(headline: string | null | undefined): string {
  if (!headline) return 'var(--text-muted)'
  if (headline.startsWith('Covered')) return 'rgb(52, 211, 153)'
  if (headline === 'Generating') return 'rgb(56, 189, 248)'
  if (headline === 'Stale') return 'rgb(251, 191, 36)'
  return 'var(--text-muted)'
}

// Worst-first rank for a headline — features that need attention sort above
// already-covered ones. Active (running) features float above everything else.
function headlineRank(headline: string | null | undefined): number {
  if (!headline) return 1 // unknown / not loaded yet
  if (headline === 'Setup needed') return 0
  if (headline === 'No coverage') return 0
  if (headline === 'Stale') return 1
  if (headline.startsWith('Covered')) return 3
  return 2
}

function livePhaseLabel(kind: CoverageJobIndexEntry['kind']): string {
  return kind === 'summary' ? 'summarizing…' : 'mapping…'
}

// Feature picker for the Coverage launcher — mirrors PortifyPickerDialog. Lists
// every feature with its coverage status; selecting one resumes its ledger.
function CoveragePickerDialog({
  features,
  jobs,
  onPick,
  onClose,
}: {
  features: { name: string }[]
  jobs: CoverageJobIndexEntry[]
  onPick: (feature: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [headlines, setHeadlines] = useState<Record<string, string | null>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Pull per-feature coverage status lazily when the dialog opens. Failures
  // degrade to neutral — rows still render and stay clickable.
  useEffect(() => {
    let alive = true
    api.listCoverageStates()
      .then((states) => {
        if (!alive) return
        const map: Record<string, string | null> = {}
        for (const s of states) map[s.feature] = s.headline
        setHeadlines(map)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // First running job per feature → the live "active" treatment for its row.
  const liveByFeature = useMemo(() => {
    const map: Record<string, CoverageJobIndexEntry> = {}
    for (const j of jobs) if (j.status === 'running' && !map[j.feature]) map[j.feature] = j
    return map
  }, [jobs])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? features.filter((f) => f.name.toLowerCase().includes(q)) : features
    // Active (running) features first; then worst-first by coverage headline;
    // then alphabetical.
    return [...list].sort((a, b) =>
      Number(Boolean(liveByFeature[b.name])) - Number(Boolean(liveByFeature[a.name]))
      || headlineRank(headlines[a.name]) - headlineRank(headlines[b.name])
      || a.name.localeCompare(b.name))
  }, [features, query, liveByFeature, headlines])

  // Portalled to <body>: the status-bar action cluster is overflow-hidden and
  // carries a transform during its collapse animation, which would clip/offset a
  // fixed dialog rendered inside it.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-end bg-black/30 p-6" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Open coverage"
        data-testid="coverage-task-menu"
        className="flex max-h-[calc(100vh-3rem)] w-[min(520px,calc(100vw-3rem))] flex-col rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cl-dialog-header">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">🎯 Open coverage</h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Pick a feature to open its Verified Coverage ledger — requirements traced to passing tests. Picks up where you left off.
            </p>
          </div>
          <button type="button" aria-label="Close coverage picker" onClick={onClose} className="rounded px-2 py-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            Close
          </button>
        </header>

        {features.length > 8 && (
          <div className="border-b px-3 py-2" style={{ borderColor: 'var(--border-default)' }}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter features…"
              className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>
        )}

        {features.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            No features detected.
          </div>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2 scrollbar-thin">
            {filtered.map((f) => {
              const live = liveByFeature[f.name]
              const headline = headlines[f.name]
              return (
                <li key={f.name}>
                  <button
                    type="button"
                    data-testid={`coverage-open-${f.name}`}
                    onClick={() => { onPick(f.name) }}
                    className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
                    style={{ border: '1px solid var(--border-default)' }}
                    title={live ? `View ${live.kind} generation for ${f.name}` : `Open coverage ledger for ${f.name}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{f.name}</span>
                    {live ? (
                      <span
                        className="shrink-0 inline-flex items-center gap-1.5 text-[10.5px] font-medium"
                        style={{ color: 'rgb(56, 189, 248)' }}
                      >
                        <StatusDot state="running" halo className="shrink-0" />
                        {livePhaseLabel(live.kind)}
                      </span>
                    ) : headline ? (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                        style={{ color: headlineTone(headline), border: `1px solid color-mix(in srgb, ${headlineTone(headline)} 35%, transparent)` }}
                      >
                        {headline}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                    <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      {live ? '↗' : '→'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <footer className="border-t px-4 py-2.5 text-[10.5px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
          Coverage is grounded — a requirement only counts as covered once a test for it passes a real run.
        </footer>
      </section>
    </div>,
    document.body,
  )
}
