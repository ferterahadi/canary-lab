import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { RunDetail } from '../api/types'
import { statusBadgeClass, formatDuration, durationBetween } from '../lib/format'
import { PaneTerminal } from './PaneTerminal'
import { TestStepsTab } from './TestStepsTab'
import { JournalTab } from './JournalTab'

type Tab = 'overview' | 'services' | 'playwright' | 'agent' | 'steps' | 'journal'

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'aborted'])

// Column 3 — detail tabs for the selected run.
export function RunDetailColumn({ runId }: Props): JSX.Element {
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
        // Poll faster (3s) while running so the test-steps tab can refresh
        // its coloring as soon as the summary is written. Slow back to 5s
        // once the run reaches a terminal state.
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
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Select a run.
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Loading run…
      </div>
    )
  }

  const m = detail.manifest
  const services = m.services
  const activeService = services[serviceIdx]

  return (
    <div className="relative flex h-full flex-col">
      <header className="border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-zinc-300">{m.runId}</span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusBadgeClass(m.status)}`}
          >
            {m.status}
          </span>
          <span className="text-xs text-zinc-500">{m.feature}</span>
        </div>
        <nav className="mt-2 flex gap-1 text-xs">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
          <TabButton active={tab === 'services'} onClick={() => setTab('services')} disabled={services.length === 0}>
            Services
          </TabButton>
          <TabButton active={tab === 'playwright'} onClick={() => setTab('playwright')}>Playwright</TabButton>
          <TabButton active={tab === 'agent'} onClick={() => setTab('agent')}>Heal agent</TabButton>
          <TabButton active={tab === 'steps'} onClick={() => setTab('steps')}>Test steps</TabButton>
          <TabButton active={tab === 'journal'} onClick={() => setTab('journal')}>Journal</TabButton>
        </nav>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'overview' && (
          <div className="overflow-y-auto p-4 text-sm">
            <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-xs">
              <dt className="text-zinc-500">Feature</dt><dd>{m.feature}</dd>
              <dt className="text-zinc-500">Started</dt><dd className="font-mono">{m.startedAt}</dd>
              <dt className="text-zinc-500">Ended</dt><dd className="font-mono">{m.endedAt ?? '—'}</dd>
              <dt className="text-zinc-500">Duration</dt>
              <dd>{(() => {
                const d = durationBetween(m.startedAt, m.endedAt)
                return d == null ? 'in progress' : formatDuration(d)
              })()}</dd>
              <dt className="text-zinc-500">Heal cycles</dt><dd>{m.healCycles}</dd>
            </dl>
            <h3 className="mt-4 mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Services</h3>
            {services.length === 0 ? (
              <div className="text-xs text-zinc-500">No services configured.</div>
            ) : (
              <ul className="text-xs">
                {services.map((s) => (
                  <li key={s.safeName} className="border-b border-zinc-900 py-1">
                    <div className="font-medium text-zinc-200">{s.name}</div>
                    <div className="font-mono text-[11px] text-zinc-500">{s.command}</div>
                    <div className="font-mono text-[11px] text-zinc-600">{s.logPath}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {tab === 'services' && services.length > 0 && (
          <div className="flex h-full flex-col">
            <div className="flex gap-1 border-b border-zinc-800 px-3 py-1 text-xs">
              {services.map((s, i) => (
                <button
                  key={s.safeName}
                  type="button"
                  onClick={() => setServiceIdx(i)}
                  className={`rounded px-2 py-1 ${i === serviceIdx ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}
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
        {tab === 'steps' && (
          <TestStepsTab feature={m.feature} summary={detail.summary} />
        )}
        {tab === 'journal' && (
          <JournalTab feature={m.feature} runId={m.runId} />
        )}
      </div>
    </div>
  )
}

interface Props {
  runId: string | null
}

function TabButton(props: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  const { active, disabled, onClick, children } = props
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded px-2 py-1 ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-700'
      }`}
    >
      {children}
    </button>
  )
}
