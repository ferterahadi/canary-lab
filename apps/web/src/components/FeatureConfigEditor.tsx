import { useEffect, useState } from 'react'
import { GeneralTab } from './config/GeneralTab'
import { ReposTab } from './config/ReposTab'
import { EnvsetsTab } from './config/EnvsetsTab'
import { PlaywrightTab } from './config/PlaywrightTab'

type Tab = 'general' | 'repos' | 'envsets' | 'playwright'

interface Props {
  feature: string
  onClose: () => void
}

export function FeatureConfigEditor({ feature, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('general')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="flex h-[88vh] w-[min(960px,94vw)] flex-col overflow-hidden rounded-lg shadow-xl"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between gap-3 px-4 py-3"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Feature configuration
            </div>
            <div className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {feature}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <nav
          className="flex gap-1 px-3 py-1.5 text-xs"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          <TabButton active={tab === 'general'} onClick={() => setTab('general')}>General</TabButton>
          <TabButton active={tab === 'repos'} onClick={() => setTab('repos')}>Repos & services</TabButton>
          <TabButton active={tab === 'envsets'} onClick={() => setTab('envsets')}>Envsets</TabButton>
          <TabButton active={tab === 'playwright'} onClick={() => setTab('playwright')}>Playwright</TabButton>
        </nav>

        <div className="flex-1 min-h-0">
          {tab === 'general' && <GeneralTab feature={feature} />}
          {tab === 'repos' && <ReposTab feature={feature} />}
          {tab === 'envsets' && <EnvsetsTab feature={feature} />}
          {tab === 'playwright' && <PlaywrightTab feature={feature} />}
        </div>
      </div>
    </div>
  )
}

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  const { active, onClick, children } = props
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 transition-colors duration-150"
      style={{
        background: active ? 'var(--bg-elevated)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </button>
  )
}
