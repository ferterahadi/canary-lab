import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { Feature } from '@/shared/api/types'
import type { BenchmarkArm, BenchmarkManifest, BenchmarkReport, SabotageLevel, SabotageSkillSummary } from '../api/benchmark-types'
import { RunDetailColumn } from '@/features/runs'
import { ConfigScreen } from './BenchmarkConfigScreen'

// The benchmark workspace window: a large portal-style overlay (config → setup →
// race → report). Per-arm monitoring reuses the real RunDetailColumn.

export const LEVEL_BADGE: Record<SabotageLevel, { bg: string; fg: string }> = {
  min: { bg: 'color-mix(in srgb, var(--success) 15%, transparent)', fg: 'var(--success)' },
  med: { bg: 'color-mix(in srgb, var(--warning) 15%, transparent)', fg: 'var(--warning)' },
  max: { bg: 'color-mix(in srgb, var(--danger) 15%, transparent)', fg: 'var(--danger)' },
}

// One matrix that captures BOTH what the two benchmark arms share and where they
// diverge — so a single table tells the whole story. Mirrors the arm wiring in
// lib/runtime/benchmark/arm-config.ts + the CANARY_LAB_BENCHMARK_MODE enrichment
// gate in summary-reporter.ts. `harness`/`baseline` = whether that arm gets it.
export type ArmRow = { label: string; detail: string; harness: boolean; baseline: boolean }

export const ARM_MATRIX: { section: string; note: string; rows: ArmRow[] }[] = [
  {
    section: 'Shared — both arms start here',
    note: 'identical, so the race never measures these',
    rows: [
      { label: 'claude agent + model', detail: 'same CLI, same model', harness: true, baseline: true },
      { label: 'Frozen bug', detail: 'the same sabotage commit', harness: true, baseline: true },
      { label: 'Booted services', detail: 'the orchestrator brings the app up', harness: true, baseline: true },
      { label: 'npx playwright test', detail: 'the arm reruns the suite itself', harness: true, baseline: true },
      { label: 'Playwright MCP', detail: 'drive browser, snapshot, network', harness: true, baseline: true },
      { label: 'Own browser trace', detail: 'Playwright trace.zip in its worktree', harness: true, baseline: true },
      { label: 'Completion signal', detail: 'the .restart / .rerun protocol', harness: true, baseline: true },
    ],
  },
  {
    section: 'Canary Lab failure context — harness only',
    note: 'curated & captured by the harness — the one variable under test',
    rows: [
      { label: 'heal-index', detail: 'failed tests, assertions, editable repos, exact slice paths', harness: true, baseline: false },
      { label: 'Sliced failure logs', detail: 'per-failure service-log excerpts, not the raw log', harness: true, baseline: false },
      { label: 'Trace-extract', detail: 'failing action + selector, a11y snapshot, failed network, console', harness: true, baseline: false },
      { label: 'Diagnosis journal', detail: 'what prior heal cycles already tried', harness: true, baseline: false },
      { label: 'Captured service logs', detail: 'canary-lab’s svc-*.log capture', harness: true, baseline: false },
      { label: 'Playwright summary', detail: 'the e2e-summary.json reporter output', harness: true, baseline: false },
      { label: 'Feature docs / wiki', detail: 'product context + preserved prior work', harness: true, baseline: false },
    ],
  },
]

export function Cell({ on }: { on: boolean }) {
  return (
    <span style={{ textAlign: 'center', fontWeight: 700, color: on ? 'var(--success)' : 'var(--text-muted)', opacity: on ? 1 : 0.5 }}>
      {on ? '✓' : '✗'}
    </span>
  )
}

// The unified comparison table — similarities AND differences in one grid.
export function ArmMatrixTable() {
  const COLS = '1fr 84px 84px'
  return (
    <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', background: 'var(--bg-surface)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', padding: '9px 15px', borderBottom: '1px solid var(--border-default)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
        <span>Capability</span>
        <span style={{ textAlign: 'center', color: 'var(--boot)' }}>🐤 Harness</span>
        <span style={{ textAlign: 'center', color: 'var(--accent)' }}>⚙ Baseline</span>
      </div>
      {ARM_MATRIX.map((group) => (
        <Fragment key={group.section}>
          <div style={{ padding: '9px 15px 7px', background: 'var(--bg-base)', borderBottom: '1px solid var(--border-default)' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>{group.section}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>{group.note}</span>
          </div>
          {group.rows.map((row) => (
            <div key={row.label} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', padding: '9px 15px', borderTop: '1px solid var(--border-default)' }}>
              <span style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{row.label}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> — {row.detail}</span>
              </span>
              <Cell on={row.harness} />
              <Cell on={row.baseline} />
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  )
}

// Dedicated page (reached from the setup screen) so the full comparison has room
// to breathe instead of cluttering the benchmark config form.
export function ArmComparisonPage({ onBack }: { onBack: () => void }) {
  return (
    // alignItems:flex-start: see ConfigScreen — default `stretch` would pin
    // this child to the visible height and swallow the bottom padding.
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 96px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <div style={{ width: 'min(820px, 100%)' }}>
        <button
          type="button"
          onClick={onBack}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: '4px 0', marginBottom: 14 }}
        >
          <span aria-hidden>←</span> Back to setup
        </button>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>How the two arms differ</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 18, maxWidth: 640 }}>
          Both arms run the same agent against the same frozen bug with the same tooling. The benchmark isolates a{' '}
          <b style={{ color: 'var(--text-secondary)' }}>single variable</b> — canary-lab’s curated &amp; captured
          failure context — so any speed or success-rate gap is attributable to that context alone.
        </div>
        <ArmMatrixTable />
      </div>
    </div>
  )
}

export function badgeStyle(level: SabotageLevel): React.CSSProperties {
  const b = LEVEL_BADGE[level]
  return { background: b.bg, color: b.fg }
}

export function cell(right = false, color?: string): React.CSSProperties {
  return { textAlign: right ? 'right' : 'left', padding: '9px 12px', borderBottom: '1px solid var(--border-default)', fontFamily: right ? 'var(--font-mono)' : undefined, color }
}
