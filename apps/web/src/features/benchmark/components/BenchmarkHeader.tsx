import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { BenchmarkArm, BenchmarkManifest, BenchmarkReport, SabotageLevel, SabotageSkillSummary } from '../api/benchmark-types'

// Lifecycle → stepper index. 0 Sabotage (config) · 1 Progress (sabotaging) ·
// 2 Race (running) · 3 Report (terminal).
export function lifecycleStage(status?: BenchmarkManifest['status']): number {
  if (!status) return 0
  if (status === 'sabotaging' || status === 'ready') return 1
  if (status === 'running') return 2
  return 3
}

export function isTerminal(status?: string): boolean {
  return status === 'done' || status === 'aborted' || status === 'error' || status === 'invalid'
}

export const STAGE_LABELS = ['Sabotage', 'Progress', 'Race', 'Report'] as const

// The journey indicator: Sabotage → Progress → Race → Report. The current stage
// is filled, completed stages get a check, upcoming ones stay muted. Race and
// Report become clickable once reachable, so the stepper doubles as the view
// switcher (replacing the old Race/Report tabs).
export function StageStepper({
  stage,
  status,
  view,
  onSelectView,
}: {
  stage: number
  status?: BenchmarkManifest['status']
  view?: 'race' | 'report'
  onSelectView?: (v: 'race' | 'report') => void
}) {
  const activeIndex = stage <= 1 ? stage : stage === 2 ? 2 : view === 'report' ? 3 : 2
  return (
    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
      {STAGE_LABELS.map((label, i) => {
        const reached = i <= stage
        const done = i < stage
        const isActive = i === activeIndex
        const clickable = !!onSelectView && ((i === 2 && stage >= 2) || (i === 3 && stage >= 3))
        const pulse = isActive && ((i === 1 && status === 'sabotaging') || (i === 2 && status === 'running'))
        return (
          <Fragment key={label}>
            {i > 0 && (
              <span
                aria-hidden="true"
                style={{
                  width: 24, height: 2, borderRadius: 2, margin: '0 8px', flex: 'none',
                  background: i <= stage ? 'var(--accent)' : 'var(--border-default)',
                  opacity: i <= stage ? 0.75 : 1, transition: 'background 240ms ease',
                }}
              />
            )}
            <span
              onClick={clickable ? () => onSelectView!(i === 3 ? 'report' : 'race') : undefined}
              title={clickable ? `View ${label.toLowerCase()}` : undefined}
              aria-current={isActive ? 'step' : undefined}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: clickable ? 'pointer' : 'default', userSelect: 'none' }}
            >
              <span
                className={pulse ? 'animate-pulse' : undefined}
                style={{
                  width: 18, height: 18, borderRadius: 9999, display: 'grid', placeItems: 'center',
                  fontSize: 10, fontWeight: 700, flex: 'none',
                  border: `1.5px solid ${reached ? 'var(--accent)' : 'var(--border-default)'}`,
                  background: isActive ? 'var(--accent)' : done ? 'var(--accent-soft)' : 'transparent',
                  color: isActive ? 'var(--bg-base)' : reached ? 'var(--accent)' : 'var(--text-muted)',
                  boxShadow: isActive ? '0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent)' : 'none',
                  transition: 'background 200ms ease, color 200ms ease, border-color 200ms ease, box-shadow 200ms ease',
                }}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                style={{
                  fontSize: 12, fontWeight: isActive ? 600 : 500,
                  color: isActive ? 'var(--text-primary)' : reached ? 'var(--text-secondary)' : 'var(--text-muted)',
                  transition: 'color 200ms ease', whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}

// Unified window header: identity + actions row over the stage stepper row.
// Shared by the config screen (stage 0) and the live detail view.
export function BenchmarkHeader({
  stage,
  status,
  title,
  view,
  onSelectView,
  iteration,
  totalIterations,
  onStop,
  onNew,
  onClose,
}: {
  stage: number
  status?: BenchmarkManifest['status']
  title: string
  view?: 'race' | 'report'
  onSelectView?: (v: 'race' | 'report') => void
  iteration?: number
  totalIterations?: number
  onStop?: () => void
  onNew?: () => void
  onClose: () => void
}) {
  const active = status === 'sabotaging' || status === 'ready' || status === 'running'
  const dot = !status
    ? 'var(--accent)'
    : status === 'done'
      ? 'var(--accent)'
      : status === 'invalid'
        ? 'var(--warning)'
        : status === 'error' || status === 'aborted'
          ? 'var(--danger)'
          : 'var(--running)'
  return (
    <div style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px 8px' }}>
        <span style={{ width: 9, height: 9, borderRadius: 9999, background: dot, flex: 'none' }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 13, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px',
            padding: '2px 7px', borderRadius: 'var(--radius-sm)', background: 'var(--accent-soft)',
            color: 'var(--accent)', flex: 'none',
          }}
        >
          Benchmark
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onStop && (
            <button
              className="cl-button"
              style={{ padding: '6px 12px', color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))' }}
              onClick={onStop}
            >
              ■ Stop
            </button>
          )}
          {onNew && !active && (
            <button className="cl-button" style={{ padding: '6px 12px' }} onClick={onNew}>＋ New</button>
          )}
          <button className="cl-button" style={{ padding: '6px 12px' }} onClick={onClose}>Close ✕</button>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 16px 11px' }}>
        <StageStepper stage={stage} status={status} view={view} onSelectView={onSelectView} />
        <span style={{ flex: '1 1 auto' }} />
        {iteration != null && totalIterations != null && stage >= 2 && view === 'race' && (
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px',
              border: '1px solid var(--border-default)', borderRadius: 9999, fontSize: 11, color: 'var(--text-muted)', flex: 'none',
            }}
          >
            Iteration <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{iteration}</b> /{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{totalIterations}</span>
          </span>
        )}
      </div>
    </div>
  )
}
