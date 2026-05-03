import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { RunDetail, ServiceStatus } from '../api/types'
import { formatDuration, durationBetween } from '../lib/format'
import { RunStatusIndicator } from './RunStatusIndicator'
import { PaneTerminal } from './PaneTerminal'
import { JournalTab } from './JournalTab'
import { ManualHealBanner } from './ManualHealBanner'
import { AgentInputBar } from './AgentInputBar'

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
          <span className="shrink-0">
            <RunStatusIndicator status={m.status} />
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
          <div className="h-full overflow-y-auto scrollbar-thin p-4 text-sm">
            <SectionHeader>Run</SectionHeader>
            <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1.5 text-xs">
                <dt style={{ color: 'var(--text-muted)' }}>Feature</dt>
                <dd className="truncate" style={{ color: 'var(--text-primary)' }} title={m.feature}>{m.feature}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Duration</dt>
                <dd style={{ color: 'var(--text-primary)' }}>{(() => {
                  const d = durationBetween(m.startedAt, m.endedAt)
                  return d == null ? 'in progress' : formatDuration(d)
                })()}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Started</dt>
                <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={m.startedAt}>{m.startedAt}</dd>
                {m.endedAt && (
                  <>
                    <dt style={{ color: 'var(--text-muted)' }}>Ended</dt>
                    <dd className="truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }} title={m.endedAt}>{m.endedAt}</dd>
                  </>
                )}
                {m.healCycles > 0 && (
                  <>
                    <dt style={{ color: 'var(--text-muted)' }}>Heal cycles</dt>
                    <dd style={{ color: 'var(--text-secondary)' }}>{m.healCycles}</dd>
                  </>
                )}
            </dl>
            <div className="mt-4">
              <SectionHeader>Services</SectionHeader>
              {services.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No services configured.</div>
              ) : (
                <ul className="space-y-2">
                  {services.map((s) => (
                    <ServiceCard key={s.safeName} service={s} />
                  ))}
                </ul>
              )}
            </div>
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
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors duration-150"
                  style={{
                    background: i === serviceIdx ? 'var(--bg-elevated)' : 'transparent',
                    color: i === serviceIdx ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  <ServiceStatusDot status={s.status} />
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
          <div className="flex h-full flex-col">
            {m.healMode === 'manual' && m.status === 'healing' && m.signalPaths && (
              <ManualHealBanner runId={m.runId} signalPaths={m.signalPaths} />
            )}
            <div className="flex-1 min-h-0">
              <PaneTerminal runId={m.runId} paneId="agent" />
            </div>
            {m.status === 'healing' && m.healMode !== 'manual' && (
              <AgentInputBar runId={m.runId} />
            )}
          </div>
        )}
        {tab === 'journal' && (
          <JournalTab feature={m.feature} runId={m.runId} />
        )}
      </div>
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
      {children}
    </h2>
  )
}

const STATUS_COLOR: Record<ServiceStatus, string> = {
  ready: '#22c55e',
  starting: '#eab308',
  timeout: '#ef4444',
  stopped: 'var(--text-muted)',
}

function ServiceCard({ service }: { service: { name: string; command: string; cwd: string; logPath: string; healthUrl?: string; status?: ServiceStatus } }) {
  return (
    <li className="rounded-md p-3" style={{ border: '1px solid var(--border-default)' }}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{service.name}</div>
        {service.status && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
            style={{ background: 'var(--bg-elevated)', color: STATUS_COLOR[service.status] }}
          >
            {service.status}
          </span>
        )}
      </div>
      <div className="mt-2 grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
        <ServiceField label="cmd" value={service.command} />
        <ServiceField label="cwd" value={service.cwd} />
        <ServiceField label="log" value={service.logPath} />
        {service.healthUrl && <ServiceField label="url" value={service.healthUrl} href={service.healthUrl} />}
      </div>
    </li>
  )
}

function ServiceField({ label, value, href }: { label: string; value: string; href?: string }) {
  const onCopy = () => {
    void navigator.clipboard?.writeText(value)
  }
  return (
    <>
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span
        className="min-w-0 truncate text-[11px]"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
        title={value}
      >
        {value}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${label}`}
            className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg-elevated)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3h7v7" />
              <path d="M10 14L21 3" />
              <path d="M21 14v7H3V3h7" />
            </svg>
          </a>
        )}
        {!href && (
          <button
            type="button"
            onClick={onCopy}
            aria-label={`Copy ${label}`}
            title={`Copy ${label}`}
            className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg-elevated)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        )}
      </span>
    </>
  )
}

function ServiceStatusDot({ status }: { status?: ServiceStatus }) {
  // Fixed 6×6 slot reserved regardless of status, so the chip text never
  // shifts when the dot appears/disappears (e.g. on `stopped`).
  const color =
    status === 'ready' ? '#22c55e'      // green
    : status === 'starting' ? '#eab308' // yellow (pulses)
    : status === 'timeout' ? '#ef4444'  // red
    : 'transparent'                     // stopped or undefined
  return (
    <span
      aria-label={status ? `service ${status}` : undefined}
      className={`inline-block h-1.5 w-1.5 rounded-full shrink-0${status === 'starting' ? ' canary-pulse' : ''}`}
      style={{ background: color }}
    />
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
