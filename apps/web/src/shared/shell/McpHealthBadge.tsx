import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import { useDismissOnOutsideMousedown, useEscapeToClose } from '@/shared/ui/Overlays'
import { useAnchoredPosition } from '@/shared/ui/use-anchored-position'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as configApi from '../api/config'
import { capitalizeFirst, shortTime } from '@/shared/lib/format'
import { StatusDot, type StatusDotState } from '@/shared/ui/atoms'
import { CopyField } from '@/shared/ui/CopyField'
import { DisclosureCaret } from '@/shared/ui/Icons'
import { displayError } from '@/shared/api/error-message'
import { usePersistedFlag } from '@/shared/state/browser-storage'
import { clampToViewport } from '@/shared/lib/viewport'

const MCP_PROFILE = 'compact'

type McpHealthState =
  | { state: 'checking'; projectRoot?: string; error?: string }
  | { state: 'ready'; projectRoot: string; error?: string }
  | { state: 'failed'; projectRoot?: string; error: string }

export function McpHealthBadge() {
  const [health, setHealth] = useState<McpHealthState>({ state: 'checking' })
  const [lastCheckedLabel, setLastCheckedLabel] = useState<string | null>(null)
  const [checkMessage, setCheckMessage] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 320 })
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const testConnection = useCallback(async (): Promise<void> => {
    setHealth((current) => ({
      state: 'checking',
      projectRoot: current.projectRoot,
    }))
    setCheckMessage(null)
    try {
      const result = await configApi.getMcpHealth()
      const checkedAt = shortTime(new Date().toISOString())
      setHealth({
        state: 'ready',
        projectRoot: result.projectRoot,
      })
      setLastCheckedLabel(checkedAt)
      setCheckMessage(`Health OK at ${checkedAt}`)
    } catch (err) {
      const message = displayError(err, 'MCP health check failed')
      setHealth({
        state: 'failed',
        error: message,
      })
      setCheckMessage(message)
    }
  }, [])

  useEffect(() => {
    void testConnection()
  }, [testConnection])

  const updateMenuPosition = useCallback((): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(360, Math.max(304, window.innerWidth - 16))
    const left = clampToViewport(rect, width, 'start', window.innerWidth)
    setMenuPosition({ top: rect.bottom + 8, left, width })
  }, [])

  useAnchoredPosition(open, updateMenuPosition)
  // The menu is portaled, so it is not inside the button: both count as in.
  useDismissOnOutsideMousedown(() => setOpen(false), open, [buttonRef, menuRef])
  useEscapeToClose(() => setOpen(false), open)

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
        className="cl-button flex items-center gap-1.5 px-2 py-0.5"
        // Inline, not a `text-[11px]` utility: `.cl-button` sits outside
        // Tailwind's layer, so its own 12px font-size wins over the class and
        // the badge silently renders a size larger than the ConnectionBadge
        // beside it. These two values match that chip's line box exactly, so the
        // pair is the same height either side of the divider.
        style={{ fontSize: 11, lineHeight: 1.5 }}
        title={title}
        aria-label="MCP connection details"
        aria-expanded={open}
      >
        <StatusDot state={p.dot} pulse={p.pulse} halo={p.pulse} />
        <span>MCP</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
          {capitalizeFirst(p.label)}
        </span>
      </button>
      {open && createPortal(
        <McpHealthMenu
          ref={menuRef}
          health={health}
          position={menuPosition}
          lastCheckedLabel={lastCheckedLabel}
          checkMessage={checkMessage}
        />,
        document.body,
      )}
    </div>
  )
}

const McpHealthMenu = forwardRef<HTMLDivElement, {
  health: McpHealthState
  position: { top: number; left: number; width: number }
  lastCheckedLabel: string | null
  checkMessage: string | null
}>(function McpHealthMenu({
  health,
  position,
  lastCheckedLabel,
  checkMessage,
}, ref) {
  return (
    <div
      ref={ref}
      data-mcp-health-menu
      role="dialog"
      aria-label="MCP connection details"
      className="cl-popover fixed z-[80] flex flex-col overflow-hidden"
      style={{
        top: position.top,
        left: position.left,
        width: position.width,
        color: 'var(--text-primary)',
      }}
    >
      <div className="shrink-0 border-b px-3 py-2.5" style={{ borderColor: 'var(--border-default)' }}>
        <div className="min-w-0">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            MCP endpoint
          </div>
          <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {health.state === 'failed' ? health.error : 'Compact profile for external agents'}
          </div>
        </div>
      </div>
      <McpConnectGuide healthy={health.state === 'ready'} />
      <div className="shrink-0 border-t px-3 py-1.5" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span className="truncate">{checkMessage ?? 'Checks the compact profile health endpoint'}</span>
          {lastCheckedLabel && <span className="shrink-0">{lastCheckedLabel}</span>}
        </div>
      </div>
    </div>
  )
})

// Disclosure that rehearses the README "how to connect" steps without making
// the user leave the UI. The open/closed choice persists across opens. The
// endpoint derives from the live origin (UI + MCP share one configured port)
// and keeps compact explicit so the copied URL documents the intended surface.
function McpConnectGuide({ healthy }: { healthy: boolean }) {
  const [open, setOpen] = usePersistedFlag('cl-mcp-connect-open', false)
  const endpoint = `${window.location.origin}/mcp?profile=${MCP_PROFILE}`
  const toggle = (): void => setOpen((current) => !current)
  return (
    <div className="shrink-0">
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
        <DisclosureCaret open={open} className="" />
      </button>
      {open && (
        <ol className="flex flex-col gap-2 px-3 pb-3 pt-0.5">
          <ConnectStep n={1} title="Run setup in your workspace">
            <CopyField value="npx canary-lab setup --force" label="setup command" />
            <p className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Registers only the compact MCP profile with supported AI agents.
            </p>
          </ConnectStep>
          <ConnectStep n={2} title="Or point a custom client to compact">
            <CopyField value={endpoint} label="MCP endpoint URL" />
            <p className="mt-1 text-[10px]" style={{ color: healthy ? 'var(--text-muted)' : 'var(--warning, var(--text-muted))' }}>
              {healthy
                ? 'Streamable HTTP using profile=compact.'
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
