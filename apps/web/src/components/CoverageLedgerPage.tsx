import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { CoverageLedger, GapType, RequirementCoverage, TestCoverage } from '../api/types'
import { CoverageDocsTab } from './CoverageDocsTab'

interface Props {
  feature: string
  onClose: () => void
}

// Each gap class gets a stable label + colour. `unverified` is the dangerous one
// (a test exists but no passing run backs it) so it borrows the danger hue;
// `shallow-verified` is amber (passes, but only a weak assertion tier).
const GAP_META: Record<GapType, { label: string; color: string }> = {
  verified: { label: 'Verified', color: 'rgb(52, 211, 153)' },
  'shallow-verified': { label: 'Shallow', color: 'rgb(251, 191, 36)' },
  'path-incomplete': { label: 'Path-incomplete', color: 'rgb(56, 189, 248)' },
  unverified: { label: 'Unverified', color: 'rgb(251, 113, 133)' },
  untested: { label: 'Untested', color: 'var(--text-muted)' },
}

const BADGE_ORDER: GapType[] = ['untested', 'unverified', 'path-incomplete', 'shallow-verified']

// Golden-angle hue rotation gives each test a distinct, stable colour regardless
// of how many there are. Mid lightness reads on both light and dark themes.
function testColor(index: number): string {
  return `hsl(${Math.round((index * 137.508) % 360)}, 65%, 55%)`
}

interface Hovered {
  kind: 'test' | 'req'
  key: string
}

export function CoverageLedgerPage({ feature, onClose }: Props) {
  const [ledger, setLedger] = useState<CoverageLedger | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<Hovered | null>(null)
  const [gapFilter, setGapFilter] = useState<GapType | null>(null)
  const [tab, setTab] = useState<'ledger' | 'docs'>('ledger')

  const refresh = useCallback(() => {
    setLoading(true)
    api.getFeatureCoverage(feature)
      .then((data) => { setLedger(data); setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [feature])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Stable colour per test name (by position in the ledger's test list).
  const colorByTest = useMemo(() => {
    const map = new Map<string, string>()
    ledger?.tests.forEach((t, i) => map.set(t.name, testColor(i)))
    return map
  }, [ledger])

  // The two-way highlight relation: a hovered test lights its requirements; a
  // hovered requirement lights its tests.
  const { activeReqIds, activeTestNames } = useMemo(() => {
    const reqIds = new Set<string>()
    const testNames = new Set<string>()
    if (hovered && ledger) {
      if (hovered.kind === 'test') {
        testNames.add(hovered.key)
        const t = ledger.tests.find((x) => x.name === hovered.key)
        for (const id of t?.requirements ?? []) reqIds.add(id)
      } else {
        reqIds.add(hovered.key)
        for (const t of ledger.tests) {
          if (t.requirements.includes(hovered.key)) testNames.add(t.name)
        }
      }
    }
    return { activeReqIds: reqIds, activeTestNames: testNames }
  }, [hovered, ledger])

  const visibleReqs = useMemo(() => {
    if (!ledger) return []
    return gapFilter ? ledger.requirements.filter((r) => r.gapType === gapFilter) : ledger.requirements
  }, [ledger, gapFilter])

  return (
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: 'var(--bg-base)' }} data-testid="coverage-ledger">
      <div className="flex shrink-0 items-center gap-4 border-b px-5 py-3" style={{ borderColor: 'var(--border-default)' }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {(['ledger', 'docs'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              style={{
                background: tab === t ? 'var(--bg-selected)' : 'var(--bg-surface)',
                color: tab === t ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: 'none',
                borderRight: t === 'ledger' ? '1px solid var(--border-default)' : 'none',
                padding: '6px 16px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t === 'ledger' ? 'Coverage' : 'Docs'}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Verified Coverage · <strong style={{ color: 'var(--text-primary)' }}>{feature}</strong>
        </span>
        {ledger?.docsDrift && (
          <span
            data-testid="drift-banner"
            title="Source docs changed since the PRD summary was generated"
            style={{ fontSize: 12, color: 'rgb(251, 191, 36)', border: '1px solid rgb(251,191,36)', borderRadius: 'var(--radius-md)', padding: '2px 8px' }}
          >
            Docs changed — regenerate
          </span>
        )}
        <button type="button" onClick={onClose} className="cl-button ml-auto px-3 py-1.5" aria-label="Close coverage">
          Close ✕
        </button>
      </div>

      {loading && <div className="p-6" style={{ color: 'var(--text-secondary)' }}>Loading coverage…</div>}
      {error && <div className="p-6" style={{ color: 'rgb(251, 113, 133)' }}>Failed to load coverage: {error}</div>}

      {!loading && !error && ledger && tab === 'docs' && (
        <CoverageDocsTab feature={feature} onRegenerated={refresh} />
      )}

      {!loading && !error && ledger && tab === 'ledger' && (
        <>
          <CoverageHeader ledger={ledger} gapFilter={gapFilter} onToggleGap={(g) => setGapFilter((cur) => (cur === g ? null : g))} />
          <div className="flex min-h-0 flex-1">
            {/* PRD / requirements pane */}
            <div className="min-h-0 flex-1 overflow-auto border-r p-4" style={{ borderColor: 'var(--border-default)' }} data-testid="prd-pane">
              {visibleReqs.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {ledger.requirements.length === 0 ? 'No PRD requirements yet. Add docs and regenerate the PRD summary in the Docs tab.' : 'No requirements match this filter.'}
                </div>
              )}
              {visibleReqs.map((rc) => (
                <RequirementCard
                  key={rc.requirement.id}
                  rc={rc}
                  colors={(ledger.tests.filter((t) => t.requirements.includes(rc.requirement.id)).map((t) => colorByTest.get(t.name)!))}
                  active={activeReqIds.has(rc.requirement.id)}
                  dimmed={Boolean(hovered) && !activeReqIds.has(rc.requirement.id)}
                  onHover={(on) => setHovered(on ? { kind: 'req', key: rc.requirement.id } : null)}
                />
              ))}
            </div>
            {/* Tests pane */}
            <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="tests-pane">
              {ledger.tests.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tests found in this feature&apos;s specs.</div>
              )}
              {ledger.tests.map((t) => (
                <TestCard
                  key={t.name}
                  test={t}
                  color={colorByTest.get(t.name)!}
                  active={activeTestNames.has(t.name)}
                  dimmed={Boolean(hovered) && !activeTestNames.has(t.name)}
                  onHover={(on) => setHovered(on ? { kind: 'test', key: t.name } : null)}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function CoverageHeader({ ledger, gapFilter, onToggleGap }: { ledger: CoverageLedger; gapFilter: GapType | null; onToggleGap: (g: GapType) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-6 border-b px-5 py-3" style={{ borderColor: 'var(--border-default)' }}>
      <CoverageRing pct={ledger.coveragePct} />
      <div className="flex flex-wrap items-center gap-2">
        {BADGE_ORDER.map((g) => {
          const count = countFor(ledger, g)
          const meta = GAP_META[g]
          const on = gapFilter === g
          return (
            <button
              key={g}
              type="button"
              data-testid={`gap-badge-${g}`}
              aria-pressed={on}
              onClick={() => onToggleGap(g)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: on ? 'var(--bg-selected)' : 'var(--bg-surface)',
                border: `1px solid ${count > 0 ? meta.color : 'var(--border-default)'}`,
                borderRadius: 'var(--radius-md)', padding: '3px 10px', fontSize: 12, cursor: 'pointer',
                color: 'var(--text-primary)', opacity: count > 0 ? 1 : 0.5,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color }} />
              {meta.label}
              <strong>{count}</strong>
            </button>
          )
        })}
      </div>
      <div className="ml-auto" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        <strong style={{ color: 'var(--text-primary)' }}>{ledger.totals.verified}</strong> / {ledger.totals.total} requirements verified
        {ledger.orphanRequirementIds.length > 0 && (
          <span data-testid="orphan-note" title={ledger.orphanRequirementIds.join(', ')} style={{ marginLeft: 12, color: 'rgb(251, 191, 36)' }}>
            {ledger.orphanRequirementIds.length} orphan annotation{ledger.orphanRequirementIds.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  )
}

function countFor(ledger: CoverageLedger, g: GapType): number {
  switch (g) {
    case 'untested': return ledger.totals.untested
    case 'unverified': return ledger.totals.unverified
    case 'path-incomplete': return ledger.totals.pathIncomplete
    case 'shallow-verified': return ledger.totals.shallowVerified
    case 'verified': return ledger.totals.verified
  }
}

function CoverageRing({ pct }: { pct: number }) {
  const r = 22
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100)
  return (
    <div style={{ position: 'relative', width: 56, height: 56 }} data-testid="coverage-ring" aria-label={`${pct}% verified`}>
      <svg width={56} height={56} viewBox="0 0 56 56">
        <circle cx={28} cy={28} r={r} fill="none" stroke="var(--border-default)" strokeWidth={5} />
        <circle
          cx={28} cy={28} r={r} fill="none" stroke="rgb(52, 211, 153)" strokeWidth={5}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          transform="rotate(-90 28 28)"
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
        {Math.round(pct)}%
      </div>
    </div>
  )
}

function RequirementCard({ rc, colors, active, dimmed, onHover }: {
  rc: RequirementCoverage
  colors: string[]
  active: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
}) {
  const meta = GAP_META[rc.gapType]
  const rigor = rc.rigor
  return (
    <div
      data-testid={`req-${rc.requirement.id}`}
      data-active={active ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        position: 'relative',
        marginBottom: 10,
        padding: '10px 12px 10px 14px',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--bg-selected)' : 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderLeft: `4px solid ${colors[0] ?? 'var(--border-default)'}`,
        opacity: dimmed ? 0.45 : 1,
        transition: 'opacity 120ms, background 120ms',
      }}
    >
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--text-secondary)' }}>{rc.requirement.id}</span>
        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{rc.requirement.title}</strong>
        {rc.requirement.deprecated && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(deprecated)</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: meta.color }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color }} />
          {meta.label}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{rc.requirement.text}</div>
      <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 6 }}>
        {rc.pathCoverage.map((p) => (
          <span key={p.path} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, border: '1px solid var(--border-default)', color: p.verified ? 'rgb(52,211,153)' : 'var(--text-muted)' }}>
            {p.path} {p.verified ? '✓' : '○'}
          </span>
        ))}
        {rigor && rigor.tierReached != null && rigor.tierAvailable != null && (
          <span
            data-testid={`strictness-${rc.requirement.id}`}
            title={rigor.suggestedStrongerCheck ? `Stronger check: ${rigor.suggestedStrongerCheck}` : undefined}
            style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 6, marginLeft: 'auto',
              border: `1px solid ${rc.gapType === 'shallow-verified' ? 'rgb(251,191,36)' : 'var(--border-default)'}`,
              color: rc.gapType === 'shallow-verified' ? 'rgb(251,191,36)' : 'var(--text-secondary)',
            }}
          >
            strictness tier {rigor.tierReached}/{rigor.tierAvailable}
          </span>
        )}
      </div>
    </div>
  )
}

function TestCard({ test, color, active, dimmed, onHover }: {
  test: TestCoverage
  color: string
  active: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
}) {
  return (
    <div
      data-testid={`test-${test.name}`}
      data-active={active ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        marginBottom: 10,
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--bg-selected)' : 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderLeft: `4px solid ${color}`,
        opacity: dimmed ? 0.45 : 1,
        transition: 'opacity 120ms, background 120ms',
      }}
    >
      <div className="flex items-center gap-2">
        <span
          title={test.verified ? 'Has a passing run' : 'No passing run yet'}
          style={{ width: 9, height: 9, borderRadius: '50%', background: test.verified ? 'rgb(52,211,153)' : 'rgb(251,113,133)', flexShrink: 0 }}
        />
        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{test.name}</strong>
      </div>
      <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 5 }}>
        {test.requirements.length === 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>no @requirement annotation</span>
        )}
        {test.requirements.map((id) => (
          <span key={id} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, background: 'color-mix(in srgb, var(--bg-base) 70%, transparent)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>{id}</span>
        ))}
        {test.pathTypes.map((p) => (
          <span key={p} style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p}</span>
        ))}
        {test.file && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>{test.file}{test.line ? `:${test.line}` : ''}</span>
        )}
      </div>
      {test.verified && test.lastPassingRun && (
        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
          last pass: run {test.lastPassingRun.runId}{test.lastPassingRun.env ? ` · ${test.lastPassingRun.env}` : ''}
        </div>
      )}
    </div>
  )
}
