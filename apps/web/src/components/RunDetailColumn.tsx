import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { RunDetail } from '../api/types'
import { statusBadgeClass, formatDuration, durationBetween } from '../lib/format'
import { PaneTerminal } from './PaneTerminal'
import { JournalTab } from './JournalTab'

type Tab = 'overview' | 'services' | 'playwright' | 'agent' | 'journal'

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'aborted'])

export function RunDetailColumn({ runId }: { runId: string | null }) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [serviceIdx, setServiceIdx] = useState(0)

  useEffect(() => {
    if (!runId) {
      setDetail(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = (): void => {
      api.getRunDetail(runId).then((data) => {
        if (cancelled) return
        setDetail(data)
        const isTerminal = TERMINAL_STATUSES.has(data.manifest.status)
        const next = isTerminal ? 5000 : 3000
        timer = setTimeout(tick, next)
      }).catch(() => {
        if (cancelled) return
        timer = setTimeout(tick, 5000)
      })
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId])

  if (!runId) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Select a run
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading...
      </div>
    )
  }

  const m = detail.manifest
  const services = m.services
  const activeService = services[serviceIdx]

  return (
    <div className="relative flex h-full flex-col">
      <header className="px-4 py-3" style={{ borderBottom: '1px solid var(--border-default)' }}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusBadgeClass(m.status)}`}>
            {m.status}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }} title={m.runId}>{m.runId}</span>
          <span className="shrink-0 truncate text-xs" style={{ color: 'var(--text-muted)' }} title={m.feature}>{m.feature}</span>
        </div>
        <nav className="mt-2 -mx-1 flex gap-1 overflow-x-auto px-1 text-xs scrollbar-thin">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
          <TabButton active={tab === 'services'} onClick={() => setTab('services')} disabled={services.length === 0}>Services</TabButton>
          <TabButton active={tab === 'playwright'} onClick={() => setTab('playwright')}>Playwright</TabButton>
          <TabButton active={tab === 'agent'} onClick={() => setTab('agent')}>Heal agent</TabButton>
          <TabButton active={tab === 'journal'} onClick={() => setTab('journal')}>Journal</TabButton>
        </nav>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden mt-2">
        {tab === 'overview' && (
          <div className="overflow-y-auto scrollbar-thin p-4 text-sm">
            <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-xs">
              <dt style={{ color: 'var(--text-muted)' }}>Feature</dt><dd style={{ color: 'var(--text-primary)' }}>{m.feature}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Started</dt><dd style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{m.startedAt}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Ended</dt><dd style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{m.endedAt ?? '—'}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Duration</dt>
              <dd style={{ color: 'var(--text-secondary)' }}>{(() => {
                const d = durationBetween(m.startedAt, m.endedAt)
                return d == null ? 'in progress' : formatDuration(d)
              })()}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Heal cycles</dt><dd style={{ color: 'var(--text-secondary)' }}>{m.healCycles}</dd>
            </dl>
            <h3 className="mt-4 mb-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Services</h3>
            {services.length === 0 ? (
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No services configured.</div>
            ) : (
              <ul className="text-xs">
                {services.map((s) => (
                  <li key={s.safeName} className="py-1.5" style={{ borderBottom: '1px solid var(--border-default)' }}>
                    <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{s.command}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{s.logPath}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {tab === 'services' && services.length > 0 && (
          <div className="flex h-full flex-col">
            <div className="flex gap-1 px-3 py-1.5 text-xs overflow-x-auto scrollbar-thin" style={{ borderBottom: '1px solid var(--border-default)' }}>
              {services.map((s, i) => (
                <button
                  key={s.safeName}
                  type="button"
                  onClick={() => setServiceIdx(i)}
                  className="rounded-md px-2 py-1 transition-colors duration-150"
                  style={{
                    background: i === serviceIdx ? 'var(--bg-elevated)' : 'transparent',
                    color: i === serviceIdx ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0">
              {activeService && (
                <PaneTerminal runId={m.runId} paneId={`service:${activeService.safeName}`} />
              )}
            </div>
          </div>
        )}
        {tab === 'playwright' && (
          <PaneTerminal runId={m.runId} paneId="playwright" />
        )}
        {tab === 'agent' && (
          <PaneTerminal runId={m.runId} paneId="agent" />
        )}
        {tab === 'journal' && (
          <JournalTab feature={m.feature} runId={m.runId} />
        )}
      </div>
    </div>
  )
}

function TabButton(props: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  const { active, disabled, onClick, children } = props
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 transition-colors duration-150"
      style={{
        background: active ? 'var(--bg-elevated)' : 'transparent',
        color: active ? 'var(--text-primary)' : disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}
