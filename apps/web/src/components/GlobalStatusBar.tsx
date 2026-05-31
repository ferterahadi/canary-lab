import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RunDetail } from '../api/types'
import * as api from '../api/client'
import { deriveRunViewModel } from '../lib/run-view-model'
import { useActiveRuns, useRuns } from '../state/RunsContext'
import { isActiveRunStatus } from '../../../../shared/run-state'
import { EvaluationExportTaskStatus } from './EvaluationExportTaskToast'
import { WizardTaskStatus } from './WizardTaskStatus'
import { RunsListDialog } from './RunsListDialog'
import { StatusDot, type StatusDotState } from './config/atoms'

interface Props {
  activeRunDetail: RunDetail | null
  onNavigateToRun?: (feature: string, runId: string) => void
}

// Always-visible top bar showing whether any run is currently active across
// all features. Single source of truth for "is something running right now?"
// — used to gate the Run Now button so we don't spawn concurrent runs that
// would saturate local resources.
//
// Also surfaces the WebSocket connection state ("connecting" / "live" /
// "reconnecting" / "disconnected"). Push frames keep run state in sync;
// when the channel drops, the user sees a banner so they know the data
// they're looking at may be stale until the socket reconnects.
export function GlobalStatusBar({ activeRunDetail, onNavigateToRun }: Props) {
  const { connection } = useRuns()
  const { count: activeCount } = useActiveRuns()
  const [runsOpen, setRunsOpen] = useState(false)
  const status = activeRunDetail?.manifest.status
  const view = deriveRunViewModel(activeRunDetail)

  // Guard: only treat 'running' and 'healing' as truly active. The runs
  // index can become stale if the orchestrator crashes, so double-check the
  // manifest status from the detail endpoint.
  const isActive = isActiveRunStatus(status)
  const services = activeRunDetail?.manifest.services ?? []
  const servicesActive = isActive

  return (
    <div className="relative">
      <div
        className="cl-shell-bar flex items-center gap-3 px-4 py-2 overflow-hidden"
      >
      <span className="shrink-0 inline-flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
          style={{
            background: 'var(--accent)',
            boxShadow: '0 0 12px color-mix(in srgb, var(--accent) 60%, transparent)',
          }}
        />
        <span className="cl-wordmark">Canary Lab</span>
      </span>
      <span className="cl-divider shrink-0">·</span>
      <ConnectionBadge state={connection} />
      <span className="cl-divider shrink-0">·</span>
      <McpHealthBadge />
      {services.length > 0 && (
        <>
          <span className="cl-divider shrink-0">·</span>
          <div className="shrink-0">
            <StatusChip
              label={`${services.length} service${services.length > 1 ? 's' : ''}`}
              state={servicesActive ? 'running' : 'idle'}
            />
          </div>
        </>
      )}
      <div className="ml-auto hidden min-w-0 items-center justify-end gap-2 sm:flex">
        {activeRunDetail && isActive && (
          <button
            type="button"
            onClick={() => onNavigateToRun?.(activeRunDetail.manifest.feature, activeRunDetail.manifest.runId)}
            className="cl-button flex min-w-0 max-w-[460px] items-center gap-2 px-2.5 py-1"
            title={`Go to active run: ${activeRunDetail.manifest.feature} ${view.headline} ${activeRunDetail.manifest.runId}`}
          >
            <span className="shrink-0" style={{ color: 'var(--text-muted)', fontSize: 11 }}>Active</span>
            <span className="truncate" style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>{activeRunDetail.manifest.feature}</span>
            <span className="hidden min-w-0 truncate xl:inline" style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>{view.headline}</span>
            <span className="hidden min-w-0 truncate 2xl:inline" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {activeRunDetail.manifest.runId}
            </span>
            <span className="shrink-0" style={{ color: 'var(--accent)' }}>→</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => setRunsOpen(true)}
          className="cl-button flex shrink-0 items-center gap-1.5 px-2.5 py-1"
          title="Show all runs"
          aria-label={`Show all runs${activeCount > 0 ? ` (${activeCount} active)` : ''}`}
        >
          <span style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 500 }}>Runs</span>
          {activeCount > 0 && (
            <span
              className="inline-flex min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold"
              style={{
                background: 'color-mix(in srgb, var(--accent) 20%, transparent)',
                color: 'var(--accent)',
              }}
            >
              {activeCount}
            </span>
          )}
        </button>
        <WizardTaskStatus />
        <EvaluationExportTaskStatus />
      </div>
      </div>
      {runsOpen && (
        <RunsListDialog
          onClose={() => setRunsOpen(false)}
          onNavigateToRun={(feature, runId) => onNavigateToRun?.(feature, runId)}
        />
      )}
    </div>
  )
}

const MCP_PROFILES = [
  { id: 'repair', label: 'Repair', detail: 'Run healing' },
  { id: 'verify', label: 'Verify', detail: 'Run checks' },
  { id: 'author', label: 'Author', detail: 'Feature setup' },
  { id: 'full', label: 'Full', detail: 'All tools' },
] as const

type McpProfile = typeof MCP_PROFILES[number]['id']

type McpHealthState =
  | { state: 'checking'; toolCount?: number; tools?: string[]; projectRoot?: string; activeSessions?: number; error?: string }
  | { state: 'ready'; toolCount: number; tools: string[]; projectRoot: string; activeSessions: number; error?: string }
  | { state: 'failed'; toolCount?: number; tools?: string[]; projectRoot?: string; activeSessions?: number; error: string }

function McpHealthBadge() {
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
  const workspaceName = workspaceNameFromRoot(health.projectRoot)
  const activeSessions = health.activeSessions ?? 0
  const profile = MCP_PROFILES.find((candidate) => candidate.id === selectedProfile) ?? MCP_PROFILES[0]
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
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span className="truncate" title={health.projectRoot ?? 'Checking'}>{workspaceName}</span>
          <span aria-hidden="true">/</span>
          <span title={profile.detail}>{profile.label}</span>
          <span aria-hidden="true">/</span>
          <span>{activeSessions} active</span>
          <span aria-hidden="true">/</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>/mcp</span>
        </div>
      </div>
      <div className="border-b px-2 py-2" style={{ borderColor: 'var(--border-default)' }}>
        <div className="mb-1 px-1 text-[10px] uppercase" style={{ color: 'var(--text-muted)', letterSpacing: 0 }}>
          Profiles
        </div>
        <div className="grid grid-cols-4 gap-1">
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

function workspaceNameFromRoot(projectRoot?: string): string {
  if (!projectRoot) return 'Checking'
  const normalized = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() || normalized
}

function formatCheckedAt(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

// Compact pill: green = WS open, amber pulse = reconnecting/connecting,
// rose = disconnected. Sits left of the MCP/services chips so the
// user sees data freshness at a glance without cluttering the bar.
function ConnectionBadge({
  state,
}: {
  state: 'connecting' | 'live' | 'reconnecting' | 'disconnected'
}) {
  const palette: Record<typeof state, { dot: StatusDotState; text: string; label: string; pulse: boolean }> = {
    live:         { dot: 'success', text: 'text-emerald-700/90 dark:text-emerald-300/90', label: 'live',         pulse: false },
    connecting:   { dot: 'warning', text: 'text-amber-700/90 dark:text-amber-300/90',     label: 'connecting',   pulse: true },
    reconnecting: { dot: 'warning', text: 'text-amber-700/90 dark:text-amber-300/90',     label: 'reconnecting', pulse: true },
    disconnected: { dot: 'failed',  text: 'text-rose-700/90 dark:text-rose-300/90',       label: 'offline',      pulse: false },
  }
  const p = palette[state]
  return (
    <div
      data-testid="runs-connection-badge"
      data-state={state}
      className={`flex shrink-0 items-center gap-1.5 ${p.text}`}
      style={{ fontSize: 11.5, fontWeight: 500 }}
      title={`Runs stream: ${p.label}`}
    >
      <StatusDot state={p.dot} pulse={p.pulse} halo={p.pulse} />
      <span>{p.label}</span>
    </div>
  )
}

function StatusChip({ label, state }: { label: string; state: 'running' | 'healing' | 'idle' }) {
  const dotState: StatusDotState =
    state === 'running' ? 'success'
    : state === 'healing' ? 'warning'
    : 'idle'
  return (
    <div
      className="flex items-center gap-1.5"
      style={{ color: 'var(--text-primary)', fontSize: 11.5, fontWeight: 500 }}
    >
      <StatusDot state={dotState} pulse={state !== 'idle'} halo={state !== 'idle'} />
      <span>{label}</span>
      <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
        {state}
      </span>
    </div>
  )
}
