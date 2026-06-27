import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as api from '../api/client'
import type { VersionStatus } from '../api/types'

// Footer version indicator. The trigger is a single 28px icon whose colour/glyph
// reads the version state; ALL copy + actions live in a portaled popover opened
// on click (mirrors McpHealthBadge), so the footer never reflows. Opens UPWARD —
// it sits at the bottom of the Features column.
//
// One surface for the whole lifecycle:
//   on latest · update available → install · installing · installed (restart) ·
//   failed → retry · offline. Meaning carries the style (a status dot + token
//   hue), per the UI design philosophy.

type Mode = 'latest' | 'available' | 'installing' | 'installed' | 'failed' | 'offline'

interface View {
  mode: Mode
  /** Trigger glyph + hue. */
  icon: ReactNode
  tone: string
  /** Status dot hue in the popover header. */
  dot: string
  title: string
}

const SVG = {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
}
const GLYPH = {
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  check: <path d="M20 6 9 17l-5-5" />,
  checkCircle: <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
  alert: <><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>,
  cloudOff: <><path d="m2 2 20 20" /><path d="M5.8 6.8A6 6 0 0 0 8 18h9a5 5 0 0 0 1.7-9.7" /></>,
}

function deriveView(status: VersionStatus): View {
  const job = status.update
  const target = status.latest
  const updateAvailable = status.updateAvailable && !!target
  if (!target) {
    return { mode: 'offline', icon: GLYPH.cloudOff, tone: 'var(--text-muted)', dot: 'var(--text-muted)', title: 'Update check unavailable' }
  }
  if (updateAvailable) {
    if (job?.status === 'done' && job.targetVersion === target) {
      return { mode: 'installed', icon: GLYPH.check, tone: 'var(--success)', dot: 'var(--success)', title: 'Update installed' }
    }
    if (job?.status === 'running') {
      return { mode: 'installing', icon: GLYPH.arrowUp, tone: 'var(--accent)', dot: 'var(--accent)', title: `Installing v${target}` }
    }
    if (job?.status === 'failed' && job.targetVersion === target) {
      return { mode: 'failed', icon: GLYPH.alert, tone: 'var(--danger)', dot: 'var(--danger)', title: 'Update failed' }
    }
    return { mode: 'available', icon: GLYPH.arrowUp, tone: 'var(--accent)', dot: 'var(--accent)', title: 'Update available' }
  }
  return { mode: 'latest', icon: GLYPH.checkCircle, tone: 'var(--text-muted)', dot: 'var(--success)', title: 'Up to date' }
}

export function VersionUpdateButton({ status }: { status: VersionStatus | null }) {
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pos, setPos] = useState({ left: 0, bottom: 0, width: 264 })
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  const reposition = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const width = 264
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8))
    // Anchor the popover's BOTTOM 8px above the trigger → opens upward,
    // height-independent (the footer hugs the bottom of the viewport).
    setPos({ left, bottom: window.innerHeight - r.top + 8, width })
  }, [])

  useEffect(() => {
    if (!open) return
    reposition()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, reposition])

  if (!status) return null
  const view = deriveView(status)
  const installing = view.mode === 'installing' || starting

  const startUpdate = async () => {
    if (installing) return
    setError(null)
    setStarting(true)
    try {
      await api.startVersionUpdate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update failed to start')
    } finally {
      setStarting(false)
    }
  }

  const triggerLabel = `Canary Lab version — ${view.title.toLowerCase()}`

  return (
    <span className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => { reposition(); setOpen((o) => !o) }}
        aria-label={triggerLabel}
        aria-expanded={open}
        title={view.title}
        className="cl-icon-button h-7 w-7"
        style={{ color: view.tone }}
      >
        <svg {...SVG}>
          {installing
            ? <g style={{ transformOrigin: 'center', animation: 'cl-spin 0.9s linear infinite' }}>{GLYPH.arrowUp}</g>
            : view.icon}
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label="Canary Lab version"
          className="cl-popover fixed z-[80] p-3"
          style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
        >
          <VersionPopover
            status={status}
            view={installing ? { ...view, mode: 'installing', title: `Installing v${status.latest}` } : view}
            error={error}
            onUpdate={startUpdate}
          />
        </div>,
        document.body,
      )}
    </span>
  )
}

function VersionPopover({
  status, view, error, onUpdate,
}: { status: VersionStatus; view: View; error: string | null; onUpdate: () => void }) {
  const current = status.current ?? '?'
  const latest = status.latest ?? '?'
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: view.dot }} aria-hidden="true" />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{view.title}</span>
      </div>

      {view.mode === 'latest' && (
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          You&apos;re running the latest version,{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>v{current}</span>.
        </p>
      )}

      {view.mode === 'offline' && (
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Couldn&apos;t reach the npm registry. You&apos;re running{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>v{current}</span>;
          we&apos;ll re-check automatically.
        </p>
      )}

      {(view.mode === 'available' || view.mode === 'failed') && (
        <>
          <VersionDelta current={current} latest={latest} />
          {view.mode === 'failed' && (
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--danger)' }}>
              {error ?? 'The install failed.'}
            </p>
          )}
          <button
            type="button"
            onClick={onUpdate}
            className="mt-0.5 w-full rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition-colors"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {view.mode === 'failed' ? 'Retry update' : `Update to v${latest}`}
          </button>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Runs <span style={{ fontFamily: 'var(--font-mono)' }}>npm install {status.packageName ?? 'canary-lab'}@latest</span> in your workspace.
          </p>
        </>
      )}

      {view.mode === 'installing' && (
        <>
          <VersionDelta current={current} latest={latest} />
          <div className="h-1 overflow-hidden rounded-full" style={{ background: 'var(--bg-selected)' }} aria-hidden="true">
            <div className="h-full w-1/3 rounded-full" style={{ background: 'var(--accent)', animation: 'cl-indeterminate 1.1s ease-in-out infinite' }} />
          </div>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Installing — keep this window open.</p>
        </>
      )}

      {view.mode === 'installed' && (
        <>
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>v{latest}</span> is installed.
            Restart the server to finish.
          </p>
          <div
            className="rounded-md border px-2 py-1 text-[11px]"
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-input)', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
          >
            canary-lab ui
          </div>
        </>
      )}
    </div>
  )
}

function VersionDelta({ current, latest }: { current: string; latest: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px]" style={{ fontFamily: 'var(--font-mono)' }}>
      <span style={{ color: 'var(--text-muted)' }}>v{current}</span>
      <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>→</span>
      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>v{latest}</span>
    </div>
  )
}
