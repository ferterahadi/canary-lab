import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as api from '../api/client'
import { StatusDot, ChevronRightIcon, type StatusDotState } from '../../features/config/components/atoms'

const MCP_PROFILES = [
  { id: 'repair', label: 'Repair', detail: 'Run healing' },
  { id: 'verify', label: 'Verify', detail: 'Run checks' },
  { id: 'author', label: 'Author', detail: 'Feature setup' },
  { id: 'lifecycle', label: 'Lifecycle', detail: 'End-to-end, no portify' },
  { id: 'portify', label: 'Portify', detail: 'Make ports injectable' },
  { id: 'full', label: 'Full', detail: 'All tools' },
] as const

type McpProfile = typeof MCP_PROFILES[number]['id']

type McpHealthState =
  | { state: 'checking'; toolCount?: number; tools?: string[]; projectRoot?: string; activeSessions?: number; error?: string }
  | { state: 'ready'; toolCount: number; tools: string[]; projectRoot: string; activeSessions: number; error?: string }
  | { state: 'failed'; toolCount?: number; tools?: string[]; projectRoot?: string; activeSessions?: number; error: string }

export function McpHealthBadge() {
  const [health, setHealth] = useState<McpHealthState>({ state: 'checking' })
  const [selectedProfile, setSelectedProfile] = useState<McpProfile>('repair')
  const [lastCheckedLabel, setLastCheckedLabel] = useState<string | null>(null)
  const [checkMessage, setCheckMessage] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 320 })
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const testConnection = useCallback(async (profile: McpProfile): Promise<void> => {
    setHealth((current) => ({
      state: 'checking',
      toolCount: current.toolCount,
      tools: current.tools,
      projectRoot: current.projectRoot,
      activeSessions: current.activeSessions,
    }))
    setCheckMessage(null)
    try {
      const result = await api.getMcpHealth(profile)
      const checkedAt = formatCheckedAt(new Date())
      setHealth({
        state: 'ready',
        toolCount: result.toolCount,
        tools: result.tools ?? [],
        projectRoot: result.projectRoot,
        activeSessions: result.activeSessions,
      })
      setLastCheckedLabel(checkedAt)
      setCheckMessage(`Health OK at ${checkedAt}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'MCP health check failed'
      setHealth({
        state: 'failed',
        error: message,
      })
      setCheckMessage(message)
    }
  }, [])

  useEffect(() => {
    void testConnection(selectedProfile)
  }, [selectedProfile, testConnection])

  const updateMenuPosition = useCallback((): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(360, Math.max(304, window.innerWidth - 16))
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    setMenuPosition({ top: rect.bottom + 8, left, width })
  }, [])

  useEffect(() => {
    if (!open) return
    updateMenuPosition()
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, updateMenuPosition])

  const palette: Record<McpHealthState['state'], { dot: StatusDotState; label: string; pulse: boolean }> = {
    checking: { dot: 'warning', label: 'checking', pulse: true },
    ready:    { dot: 'success', label: 'ready', pulse: false },
    failed:   { dot: 'failed', label: 'offline', pulse: false },
  }
  const p = palette[health.state]
  const title = health.state === 'ready'
    ? `MCP HTTP health is ready for ${health.projectRoot}`
    : health.state === 'failed'
      ? `MCP health check failed: ${health.error}`
      : 'Checking MCP HTTP health'

  return (
    <div className="shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          updateMenuPosition()
          setOpen((current) => !current)
        }}
        className="cl-button flex items-center gap-1.5 px-2 py-0.5 text-[11px]"
        title={title}
        aria-label="MCP connection details"
        aria-expanded={open}
      >
        <StatusDot state={p.dot} pulse={p.pulse} halo={p.pulse} />
        <span>MCP</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
          {p.label}
        </span>
      </button>
      {open && createPortal(
        <McpHealthMenu
          ref={menuRef}
          health={health}
          position={menuPosition}
          selectedProfile={selectedProfile}
          lastCheckedLabel={lastCheckedLabel}
          checkMessage={checkMessage}
          onSelectProfile={setSelectedProfile}
        />,
        document.body,
      )}
    </div>
  )
}

const McpHealthMenu = forwardRef<HTMLDivElement, {
  health: McpHealthState
  position: { top: number; left: number; width: number }
  selectedProfile: McpProfile
  lastCheckedLabel: string | null
  checkMessage: string | null
  onSelectProfile: (profile: McpProfile) => void
}>(function McpHealthMenu({
  health,
  position,
  selectedProfile,
  lastCheckedLabel,
  checkMessage,
  onSelectProfile,
}, ref) {
  const tools = health.tools ?? []
  return (
    <div
      ref={ref}
      data-mcp-health-menu
      role="dialog"
      aria-label="MCP connection tools"
      className="fixed z-[80] overflow-hidden rounded-md border shadow-2xl"
      style={{
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: 'min(440px, calc(100vh - 64px))',
        borderColor: 'var(--border-default)',
        background: 'color-mix(in srgb, var(--bg-elevated) 94%, black)',
        color: 'var(--text-primary)',
      }}
    >
      <div className="border-b px-3 py-2.5" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              MCP endpoint
            </div>
            <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {health.state === 'failed' ? health.error : 'Ready for external repair agents'}
            </div>
          </div>
          <div
            className="shrink-0 rounded px-2 py-1 text-[11px]"
            style={{
              background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
              color: 'var(--text-secondary)',
            }}
          >
            {health.toolCount ?? tools.length} tools
          </div>
        </div>
      </div>
      <div className="border-b px-2 py-2" style={{ borderColor: 'var(--border-default)' }}>
        <div className="mb-1 px-1 text-[10px] uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0 }}>
          Profiles
        </div>
        <div className="grid grid-cols-3 gap-1">
          {MCP_PROFILES.map((candidate) => {
            const selected = candidate.id === selectedProfile
            return (
              <button
                key={candidate.id}
                type="button"
                onClick={() => onSelectProfile(candidate.id)}
                className="min-w-0 rounded border px-2 py-1 text-center text-[11px]"
                aria-pressed={selected}
                title={candidate.detail}
                style={{
                  borderColor: selected ? 'color-mix(in srgb, var(--accent) 58%, var(--border-default))' : 'var(--border-default)',
                  background: selected
                    ? 'color-mix(in srgb, var(--accent) 13%, transparent)'
                    : 'color-mix(in srgb, var(--bg-muted) 26%, transparent)',
                }}
              >
                <span className="block truncate" style={{ color: 'var(--text-primary)' }}>{candidate.label}</span>
              </button>
            )
          })}
        </div>
      </div>
      <McpConnectGuide profile={selectedProfile} healthy={health.state === 'ready'} />
      <div className="border-b px-3 py-1.5" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center justify-between gap-2 text-[10px] uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0 }}>
          <span>Tools</span>
          <span>{tools.length} shown</span>
        </div>
      </div>
      <div className="max-h-40 overflow-y-auto px-2 py-1.5">
        {tools.length > 0 ? (
          <ul className="grid grid-cols-1 gap-1" aria-label="MCP tools">
            {tools.map((tool) => (
              <li
                key={tool}
                className="truncate rounded px-2 py-0.5 text-[11px]"
                title={tool}
                style={{
                  background: 'color-mix(in srgb, var(--bg-muted) 52%, transparent)',
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {tool}
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-2 py-5 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            Tool names are unavailable from this server.
          </div>
        )}
      </div>
      <div className="border-t px-3 py-1.5" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span className="truncate">{checkMessage ?? 'Checks the selected profile health endpoint'}</span>
          {lastCheckedLabel && <span className="shrink-0">{lastCheckedLabel}</span>}
        </div>
      </div>
    </div>
  )
})

// Disclosure that rehearses the README "how to connect" steps without making
// the user leave the UI. Collapsed by default so the tools list keeps its
// real estate; the open/closed choice persists across opens. The endpoint URL
// is derived from the live origin (UI + MCP share localhost:7421) and reflects
// the currently-selected profile so a copied URL is ready to paste verbatim.
function McpConnectGuide({ profile, healthy }: { profile: McpProfile; healthy: boolean }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cl-mcp-connect-open') === 'true'
    } catch {
      return false
    }
  })
  const endpoint = `${window.location.origin}/mcp?profile=${profile}`
  const toggle = (): void => {
    setOpen((current) => {
      const next = !current
      try {
        localStorage.setItem('cl-mcp-connect-open', String(next))
      } catch {
        /* storage unavailable — non-fatal */
      }
      return next
    })
  }
  return (
    <div className="border-b" style={{ borderColor: 'var(--border-default)' }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span
          className="flex items-center gap-1.5 text-[10px] uppercase"
          style={{ color: 'var(--text-muted)', letterSpacing: 0 }}
        >
          <PlugIcon />
          Connect a client
        </span>
        <span
          aria-hidden="true"
          className="transition-transform duration-150"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'none' }}
        >
          <ChevronRightIcon />
        </span>
      </button>
      {open && (
        <ol className="flex flex-col gap-2 px-3 pb-3 pt-0.5">
          <ConnectStep n={1} title="Run setup in your workspace">
            <CopyField value="npx canary-lab setup --force" label="setup command" />
            <p className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Registers the Canary Lab tools with supported AI agents.
            </p>
          </ConnectStep>
          <ConnectStep n={2} title="Or point a custom client here">
            <CopyField value={endpoint} label="MCP endpoint URL" />
            <p className="mt-1 text-[10px]" style={{ color: healthy ? 'var(--text-muted)' : 'var(--warning, var(--text-muted))' }}>
              {healthy
                ? 'Streamable HTTP. Switch the profile above to change the tool set.'
                : 'Endpoint is offline — start the UI server, then re-check.'}
            </p>
          </ConnectStep>
          <ConnectStep n={3} title="Restart your AI agent">
            <p className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Start a fresh session so it rediscovers the tools. <span style={{ fontFamily: 'var(--font-mono)' }}>--force</span> refreshes a registration that didn&apos;t take.
            </p>
          </ConnectStep>
        </ol>
      )}
    </div>
  )
}

function ConnectStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span
        className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold tabular-nums"
        style={{
          background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
          color: 'var(--text-secondary)',
        }}
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {title}
        </div>
        {children}
      </div>
    </li>
  )
}

// Mono command box with a click-to-copy affordance; mirrors the Copy/Copied
// text-button pattern from ManualHealBanner so the copy language is uniform.
function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — non-fatal */
    }
  }
  return (
    <div
      className="mt-1 flex items-stretch overflow-hidden rounded border"
      style={{
        borderColor: 'var(--border-default)',
        background: 'color-mix(in srgb, var(--bg-muted) 44%, transparent)',
      }}
    >
      <code
        className="min-w-0 flex-1 truncate px-2 py-1 text-[11px]"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={`Copy ${label}`}
        className="shrink-0 border-l px-2 text-[10px] uppercase transition-colors"
        style={{
          borderColor: 'var(--border-default)',
          color: copied ? 'var(--success)' : 'var(--text-muted)',
          letterSpacing: 0,
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function PlugIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" />
      <path d="M12 17v5" />
    </svg>
  )
}

function formatCheckedAt(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}
