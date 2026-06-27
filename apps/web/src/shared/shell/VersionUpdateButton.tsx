import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as api from '../api/client'
import { Tooltip } from '../ui/Tooltip'
import type { VersionStatus } from '../api/types'

// Footer version indicator. ALWAYS shown once the version check has resolved:
//  - newer version published → click runs `npm install <pkg>@latest` (the
//    server's self-update job); terminal state is "installed, restart to apply"
//    because the running process keeps the old code until `canary-lab ui`
//    restarts.
//  - already on latest → a calm check; clicking confirms "you're on the latest
//    version" with a brief inline message (it never just silently does nothing).
//  - couldn't reach the registry → shows the current version; clicking says so.
// Lives next to the theme toggle / settings gear in the Features column footer.

const ICON = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

const ICONS = {
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  check: <path d="M20 6 9 17l-5-5" />,
  checkCircle: <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
  alert: <><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>,
  cloudOff: <><path d="M12 8v4M12 16h.01" /><circle cx="12" cy="12" r="10" /></>,
}

export function VersionUpdateButton({ status }: { status: VersionStatus | null }) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Brief inline message shown after a click in a non-action state (already
  // latest / offline) so the click always "says" something. CopyButton idiom.
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<number | null>(null)
  useEffect(() => () => { if (flashTimer.current != null) window.clearTimeout(flashTimer.current) }, [])

  // Hidden only until the first version check resolves (avoids an initial flicker
  // before we know current/latest). After that it's always present.
  if (!status) return null

  const job = status.update
  const target = status.latest
  const updateAvailable = status.updateAvailable && !!target
  // A `done` job counts as "this update" only when it targeted the current
  // latest — a stale done from an older target shouldn't mask a newer release.
  const installed = updateAvailable && job?.status === 'done' && job.targetVersion === target
  const installing = updateAvailable && (starting || job?.status === 'running')
  const failed = updateAvailable && !installing && (error !== null || (job?.status === 'failed' && job.targetVersion === target))

  const showFlash = (msg: string) => {
    setFlash(msg)
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 2400)
  }

  const startUpdate = async () => {
    if (installing || installed) return
    setError(null)
    setStarting(true)
    try {
      await api.startVersionUpdate()
      // Running manifest + completion arrive via `version-changed` → App refetches.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update failed to start')
    } finally {
      setStarting(false)
    }
  }

  let label: string
  let color: string
  let icon: ReactNode
  let onClick: () => void
  let disabled = false
  let flashColor = 'var(--text-secondary)'

  if (installed) {
    label = `Updated to v${target} — restart \`canary-lab ui\` to apply`
    color = 'rgb(52, 211, 153)'
    icon = ICONS.check
    onClick = () => {}
    disabled = true
  } else if (installing) {
    label = `Installing v${target}…`
    color = 'var(--accent)'
    icon = <g style={{ transformOrigin: 'center', animation: 'cl-spin 0.9s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></g>
    onClick = () => {}
    disabled = true
  } else if (failed) {
    label = `Update to v${target} failed${error ? `: ${error}` : ''} — click to retry`
    color = 'rgb(251, 191, 36)'
    icon = ICONS.alert
    onClick = startUpdate
  } else if (updateAvailable) {
    label = `Update available — v${status.current ?? '?'} → v${target} (click to install)`
    color = 'var(--accent)'
    icon = ICONS.arrowUp
    onClick = startUpdate
  } else if (target) {
    // On the latest version — calm, but a click confirms it.
    label = `You're on the latest version (v${status.current ?? target})`
    color = 'var(--text-muted)'
    icon = ICONS.checkCircle
    flashColor = 'rgb(52, 211, 153)'
    onClick = () => showFlash(`You're on the latest version (v${status.current ?? target})`)
  } else {
    // Registry unreachable (offline / check not resolved). Show what we know.
    label = status.current
      ? `Running v${status.current} — couldn't check for updates`
      : `Couldn't check for updates`
    color = 'var(--text-muted)'
    icon = ICONS.cloudOff
    onClick = () => showFlash(
      status.current ? `You have v${status.current}; couldn't reach the registry` : `Couldn't reach the registry`,
    )
  }

  return (
    <span className="flex items-center gap-1.5">
      {flash && (
        <span
          className="whitespace-nowrap text-[11px]"
          style={{ color: flashColor }}
          aria-live="polite"
        >
          {flash}
        </span>
      )}
      <Tooltip label={label}>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className="cl-icon-button h-7 w-7"
          style={{ color }}
        >
          <svg {...ICON}>{icon}</svg>
        </button>
      </Tooltip>
    </span>
  )
}
