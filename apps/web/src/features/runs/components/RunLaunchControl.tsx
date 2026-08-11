import { type ReactNode, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition } from './RunActionsKebab'

// Inline SVG icons (no new dependency). Sizes are tuned to align with the
// 10 px text on the action buttons.
export const ICON_STOP = (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true">
    <rect x="3" y="3" width="10" height="10" rx="1.5" />
  </svg>
)

export const ICON_PAUSE = (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true">
    <rect x="3" y="3" width="3" height="10" rx="1" />
    <rect x="10" y="3" width="3" height="10" rx="1" />
  </svg>
)

type LaunchMode = 'boot' | 'test' | 'verify'

// One descriptor per mode, so the segmented tab and its action rows render the
// SAME glyph and the SAME copy from one place. Mode identity is carried by that
// glyph rather than a hue: nothing in a launch menu has a status yet, and the
// status vocabulary (emerald = passed, sky = running, teal = services up) means
// one thing everywhere — see docs/DESIGN-SYSTEM.md.
const LAUNCH_MODES: Record<LaunchMode, { label: string; note: string; icon: ReactNode }> = {
  boot: {
    label: 'Boot',
    note: 'Boots services and holds them — no tests. Manage & stop from the Services pill.',
    icon: (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="2.5" width="12" height="4" rx="1" />
        <rect x="2" y="9.5" width="12" height="4" rx="1" />
        <path d="M4.5 4.5h.01M4.5 11.5h.01" />
      </svg>
    ),
  },
  test: {
    label: 'Test',
    note: 'Boots services and runs the feature’s tests — tears them down when done.',
    icon: (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M5 3.2v9.6a.6.6 0 0 0 .92.508l7.2-4.8a.6.6 0 0 0 0-1.016l-7.2-4.8A.6.6 0 0 0 5 3.2z" />
      </svg>
    ),
  },
  verify: {
    label: 'Verify',
    note: 'Checks a deployment against target URLs — observational, no services booted.',
    icon: (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 8.5 6.2 12 13 4" />
      </svg>
    ),
  },
}

const MODE_ORDER: LaunchMode[] = ['boot', 'test', 'verify']

export function RunLaunchControl({
  feature,
  envs,
  compact = false,
  open,
  onToggle,
  onClose,
  runDisabled,
  disabledReason,
  onStartEnv,
  onVerify,
}: {
  feature: string | null
  envs: string[]
  compact?: boolean
  open: boolean
  onToggle: () => void
  onClose: () => void
  runDisabled: boolean
  disabledReason?: string
  onStartEnv: (env: string, mode: 'test' | 'boot') => void
  onVerify: () => void
}) {
  const POPOVER_WIDTH = 240
  const buttonRef = useRef<HTMLButtonElement>(null)
  const pos = useAnchoredPosition(buttonRef, open, POPOVER_WIDTH)
  const title = runDisabled && disabledReason ? disabledReason : 'Run'
  // One launch control, three modes. Test/Boot pick an envset inline; Verify
  // opens its own config dialog. `mode` is sticky within the session. Test runs
  // the suite; Boot holds services (lands in the Services pill, not Runs).
  const [mode, setMode] = useState<LaunchMode>('test')
  const launchMode: 'test' | 'boot' = mode === 'boot' ? 'boot' : 'test'
  const active = LAUNCH_MODES[mode]
  // Every mode fills the same section slot, so the label always names what the
  // rows below it are — never absent, never two spellings of one thing.
  const sectionLabel = mode === 'verify' ? 'Target' : envs.length > 0 ? 'Envset' : 'Launch'
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={!feature}
        title={title}
        onClick={() => { if (feature) onToggle() }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? 'Run' : undefined}
        data-run-launch-menu
        className={['cl-button-primary', 'cl-run-menu-button', compact && 'cl-run-menu-button-compact'].filter(Boolean).join(' ')}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M5 3.2v9.6a.6.6 0 0 0 .92.508l7.2-4.8a.6.6 0 0 0 0-1.016l-7.2-4.8A.6.6 0 0 0 5 3.2z" />
        </svg>
        {!compact && <span>Run</span>}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          role="menu"
          data-run-launch-menu
          data-mode={mode}
          onClick={(e) => e.stopPropagation()}
          className="cl-popover cl-run-launch-menu p-1.5 text-xs"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH, zIndex: 1000 }}
        >
          <div className="cl-mode-toggle" role="group" aria-label="Run mode">
            {MODE_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                data-active={mode === key}
                data-mode={key}
                onClick={() => setMode(key)}
                className="cl-mode-toggle-btn"
              >
                {LAUNCH_MODES[key].icon}
                {LAUNCH_MODES[key].label}
              </button>
            ))}
          </div>

          <p className="cl-run-launch-note">{active.note}</p>
          <div className="cl-run-launch-label">{sectionLabel}</div>

          {mode === 'verify' ? (
            <button
              type="button"
              role="menuitem"
              disabled={runDisabled}
              onClick={() => { if (!runDisabled) onVerify() }}
              className="cl-run-env-option disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="cl-run-env-option-icon" aria-hidden="true">{active.icon}</span>
              {/* Trailing ellipsis is the standard "opens further UI" cue — the
                  only row here that leads to a dialog instead of starting. */}
              <span className="min-w-0 flex-1">Set up &amp; run verify…</span>
            </button>
          ) : envs.length > 0 ? (
            envs.map((env) => (
              <button
                key={env}
                type="button"
                role="menuitem"
                disabled={runDisabled}
                onClick={() => { if (!runDisabled) onStartEnv(env, launchMode) }}
                className="cl-run-env-option disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="cl-run-env-option-icon" aria-hidden="true">{active.icon}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{env}</span>
              </button>
            ))
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={runDisabled}
              onClick={() => { if (!runDisabled) onStartEnv('', launchMode) }}
              className="cl-run-env-option disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="cl-run-env-option-icon" aria-hidden="true">{active.icon}</span>
              <span className="min-w-0 flex-1">{mode === 'boot' ? 'Boot services' : 'Run tests'}</span>
            </button>
          )}

          {runDisabled && disabledReason && (
            <p className="mx-2 mt-1 border-t border-line pt-2 text-[10px] text-muted">
              {disabledReason}
            </p>
          )}
          <button type="button" onClick={onClose} className="sr-only">Close</button>
        </div>,
        document.body,
      )}
    </>
  )
}
