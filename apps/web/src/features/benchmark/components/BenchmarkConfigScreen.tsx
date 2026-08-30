import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { Feature } from '@/shared/api/types'
import type { BenchmarkArm, BenchmarkManifest, BenchmarkReport, SabotageLevel, SabotageSkillSummary } from '../api/benchmark-types'
import { useBenchmark, useBenchmarks } from '../state/BenchmarkContext'
import { ArmComparisonPage, badgeStyle } from './BenchmarkArmMatrix'
import { BenchmarkHeader } from './BenchmarkHeader'

// ─── Config ────────────────────────────────────────────────────────────────

export function ConfigScreen({
  onClose,
  onStarted,
  startBenchmark,
  blocked,
  onOpenPortify,
}: {
  onClose: () => void
  onStarted: (id: string) => void
  startBenchmark: ReturnType<typeof useBenchmarks>['startBenchmark']
  blocked: boolean
  onOpenPortify?: (feature: string) => void
}) {
  const [features, setFeatures] = useState<Feature[]>([])
  const [feature, setFeature] = useState<string>('')
  const [skills, setSkills] = useState<SabotageSkillSummary[]>([])
  const [skill, setSkill] = useState<string>('')
  const [iterations, setIterations] = useState(2)
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'setup' | 'arms'>('setup')
  // When the selected feature's apps aren't configured for injectable ports,
  // the benchmark would clash on a hardcoded port (both arms boot it at once).
  // We park the start here and offer the port-ification workflow.
  const [gate, setGate] = useState<api.BenchmarkPreflight | null>(null)

  useEffect(() => {
    api.listFeatures().then((f) => {
      setFeatures(f)
      if (f.length && !feature) setFeature(f[0].name)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!feature) return
    api.listSabotageSkills(feature).then((s) => {
      setSkills(s)
      // Keep the current pick if the new feature still offers it (skills are
      // generic, so it usually does) — only fall back to the first otherwise.
      setSkill((prev) => (s.some((x) => x.name === prev) ? prev : s[0]?.name ?? ''))
    }).catch(() => setSkills([]))
  }, [feature])

  const selected = skills.find((s) => s.name === skill)

  const start = async () => {
    if (!feature || !selected) return
    setBusy(true); setError(null)
    try {
      // Gate: benchmark arms boot the same feature concurrently, so an app with
      // hardcoded ports clashes. Block here and offer the port-ification flow.
      const preflight = await api.benchmarkPreflight(feature)
      if (!preflight.portsConfigured) {
        setGate(preflight)
        setBusy(false)
        return
      }
      const id = await startBenchmark({ feature, skill: selected.name, level: selected.level, iterations, agent })
      onStarted(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (view === 'arms') {
    return (
      <>
        <BenchmarkHeader stage={0} title="How the arms differ" onClose={onClose} />
        <ArmComparisonPage onBack={() => setView('setup')} />
      </>
    )
  }

  return (
    <>
      <BenchmarkHeader stage={0} title="New benchmark" onClose={onClose} />
      {/* alignItems:flex-start is load-bearing: without it the default `stretch`
          pins this row-flex child to the container's *visible* height, so its
          content overflows past the scroll region and the bottom padding (the
          space under the Start-benchmark footer) is swallowed. flex-start lets
          the child grow to content+padding so the footer gets real breathing room. */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 22px 96px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div style={{ width: 'min(720px, 100%)' }}>
          <Label>Sabotage skill</Label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {skills.map((s) => (
              <div
                key={s.name}
                onClick={() => setSkill(s.name)}
                style={{
                  border: `1px solid ${skill === s.name ? 'var(--accent)' : 'var(--border-default)'}`,
                  background: skill === s.name ? 'var(--accent-soft)' : 'transparent',
                  borderRadius: 'var(--radius-lg)', padding: 13, cursor: 'pointer',
                }}
              >
                <span style={{
                  fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px',
                  padding: '2px 8px', borderRadius: 9999, ...badgeStyle(s.level),
                }}>{s.level}</span>
                <div style={{ fontWeight: 600, fontSize: 13, marginTop: 8 }}>{s.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 }}>{s.summary}</div>
              </div>
            ))}
            {skills.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                No sabotage skills for this suite. Run <span style={{ fontFamily: 'var(--font-mono)' }}>canary-lab upgrade</span> or add skills under <span style={{ fontFamily: 'var(--font-mono)' }}>sabotage-skills/</span>.
              </div>
            )}
          </div>

          {selected && (
            <>
              <Label style={{ marginTop: 16 }}>What the sabotage agent is told</Label>
              <div style={{
                background: 'var(--bg-base)', border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)', padding: '11px 13px', fontSize: 11.5,
                color: 'var(--text-secondary)', lineHeight: 1.55, whiteSpace: 'pre-wrap',
                fontFamily: 'var(--font-mono)', maxHeight: 220, overflow: 'auto',
              }}>{selected.recipe}</div>
            </>
          )}

          <Field label="Suite">
            <select
              value={feature}
              onChange={(e) => {
                // The start error (e.g. "uncommitted changes") is specific to
                // the feature that was attempted — switching feature makes it
                // stale, so drop it on change.
                setError(null)
                setFeature(e.target.value)
              }}
              className="themed-select cl-input"
              style={selectStyle}
            >
              {features.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
          </Field>

          <Field label="Heal agent">
            <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden', height: 34 }}>
              {(['claude', 'codex'] as const).map((a, i) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAgent(a)}
                  aria-pressed={agent === a}
                  style={{
                    border: 'none', cursor: 'pointer', padding: '0 16px', fontSize: 12, fontWeight: 500,
                    fontFamily: 'var(--font-mono)', textTransform: 'capitalize',
                    borderLeft: i === 1 ? '1px solid var(--border-default)' : 'none',
                    background: agent === a ? 'var(--accent-soft)' : 'var(--bg-input)',
                    color: agent === a ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  {a}
                </button>
              ))}
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11.5, marginLeft: 12 }}>
              both arms use this CLI · independent of your global heal setting
            </span>
          </Field>

          <Field label="Iterations">
            <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden', height: 34 }}>
              <Stepper onClick={() => setIterations((n) => Math.max(1, n - 1))}>−</Stepper>
              <div style={{ width: 48, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 13, borderLeft: '1px solid var(--border-default)', borderRight: '1px solid var(--border-default)', height: '100%', display: 'grid', placeItems: 'center', background: 'var(--bg-input)' }}>{iterations}</div>
              <Stepper onClick={() => setIterations((n) => Math.min(5, n + 1))}>+</Stepper>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11.5, marginLeft: 12 }}>same frozen bug, repeated → variance</span>
          </Field>

          <button
            type="button"
            onClick={() => setView('arms')}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
              background: 'transparent', border: 'none', padding: '2px 0', marginTop: 18, cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', fontWeight: 600, flex: 'none' }}>
              What each arm gets
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-muted)', opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              — only canary-lab’s curated failure context differs
            </span>
            <span aria-hidden style={{ fontSize: 11, color: 'var(--accent)', flex: 'none', fontWeight: 600 }}>Compare →</span>
          </button>

          {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 10 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--border-default)' }}>
            <span style={{ color: blocked ? 'var(--warning)' : 'var(--text-muted)', fontSize: 11.5 }}>
              {blocked
                ? 'A benchmark is already running — stop it before starting another.'
                : 'Both arms get the identical frozen break · tests stay read-only'}
            </span>
            <button className="cl-button-primary" disabled={busy || !selected || blocked} onClick={start} style={{ padding: '8px 15px' }}>
              {busy ? 'Starting…' : 'Start benchmark ▶'}
            </button>
          </div>
        </div>
      </div>

      {gate && (
        <DynamicPortsGate
          feature={feature}
          preflight={gate}
          onSetup={() => onOpenPortify?.(feature)}
          onCancel={() => setGate(null)}
        />
      )}
    </>
  )
}

// ─── Dynamic-ports gate dialog ───────────────────────────────────────────────

export function DynamicPortsGate({
  feature,
  preflight,
  onSetup,
  onCancel,
}: {
  feature: string
  preflight: api.BenchmarkPreflight
  onSetup: () => void
  onCancel: () => void
}) {
  const slotlessCommands = preflight.repos
    .flatMap((r) => r.commands.filter((c) => c.declaredPorts.length === 0).map((c) => `${r.name} · ${c.name}`))
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--overlay-backdrop)', display: 'grid', placeItems: 'center', zIndex: 70 }}>
      <div style={{ width: 'min(480px, 92%)', background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)', borderRadius: 'var(--radius-lg)', padding: 22, boxShadow: 'var(--shadow-popover)' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
          ⚠️ <span style={{ marginLeft: 4 }}>This app isn’t set up for dynamic ports</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 14 }}>
          Benchmark arms run in parallel and would collide on the same hardcoded port. Making{' '}
          <b style={{ color: 'var(--text-secondary)' }}>{feature}</b>’s ports injectable also lets you run multiple Canary runs at once.
        </div>
        {slotlessCommands.length > 0 && (
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', padding: '8px 10px', marginBottom: 16 }}>
            No port slots: {slotlessCommands.join(', ')}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} className="cl-button px-3 py-1.5">
            Cancel
          </button>
          <button type="button" className="cl-button-primary" onClick={onSetup} style={{ padding: '8px 14px' }}>
            Set up dynamic ports →
          </button>
        </div>
      </div>
    </div>
  )
}

export function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{children}</div>
}

export function Label({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', margin: '6px 0 8px', fontWeight: 600, ...style }}>{children}</div>
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '14px 0' }}>
      <label style={{ width: 90, color: 'var(--text-secondary)', fontSize: 12 }}>{label}</label>
      {children}
    </div>
  )
}

export function Stepper({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} style={{ background: 'var(--bg-surface)', border: 'none', color: 'var(--text-primary)', width: 36, height: '100%', cursor: 'pointer', fontSize: 18 }}>{children}</button>
}

// Chrome comes from themed-select + cl-input (tokens); only sizing lives here
// (right padding leaves room for the themed-select chevron).
export const selectStyle: React.CSSProperties = { padding: '7px 28px 7px 10px', fontSize: 12 }
