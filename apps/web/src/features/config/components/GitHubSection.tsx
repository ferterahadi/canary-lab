import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { GhStatus } from '@/shared/api/client'
import { RefreshIcon } from '@/shared/ui/atoms'
import { OPTION_ROW_CLASS, optionRowStyle } from '@/shared/ui/OptionRow'

// Read-only "which GitHub account is connected" surface (R80). Detect-and-
// instruct only: Canary never runs `gh auth login` and never handles the token
// — it reads gh's local status and, when something's off, shows the exact
// command the user runs themselves. Re-check on demand: auth changes outside
// the app, so the button re-fetches rather than trusting a cached value.
//
// Rendered as a ROW of Settings' GitHub section, on the shared option-row
// geometry the auto-PR checkbox above it uses: the status dot reserves the same
// 13px mark column the checkbox occupies, and everything else — label,
// remediation, footnote, the Refresh button's right edge — lines up with that
// row rather than with the section's own padding.
export function GitHubSection({ divider }: {
  /** Hairline above the row, when it follows another row in the same section. */
  divider?: boolean
}) {
  const [status, setStatus] = useState<GhStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const load = (): void => {
    setLoading(true)
    api.getGhStatus().then(setStatus).catch(() => setStatus({ installed: false, authenticated: false })).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const remediation = !status
    ? null
    : !status.installed
      ? { line: 'The GitHub CLI isn’t installed — needed to open PRs from a run’s fix.', command: 'brew install gh' }
      : !status.authenticated
        ? { line: 'Not signed in to GitHub.', command: 'gh auth login --hostname github.com --web' }
        : null

  return (
    <div
      data-testid="settings-github"
      className={`${OPTION_ROW_CLASS} ${divider ? 'border-t' : ''}`}
      // Never selected and not a control, so no hover tint and no pointer —
      // only the row's borders and padding are wanted here.
      style={optionRowStyle({ selected: false })}
    >
      <span aria-hidden className="mt-0.5 flex h-[13px] w-[13px] shrink-0 items-center justify-center">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: status?.authenticated ? 'var(--success)' : 'var(--text-muted)' }}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {/* The option-row label voice this modal's other rows use, not 14px —
              that's the dialog TITLE's size. */}
          <span className="min-w-0 truncate text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {loading
              ? 'Checking…'
              : status?.authenticated
                ? `Connected${status.account ? ` as ${status.account}` : ''}${status.host && status.host !== 'github.com' ? ` (${status.host})` : ''}`
                : status?.installed ? 'Not signed in' : 'GitHub CLI not installed'}
          </span>
          {/* An icon on the same `cl-icon-button` skin as the agent rows'
              configure gear. "Refresh" was the widest thing on a row whose
              content is WHO is connected; the glyph says re-check without
              competing with the account name. */}
          <button
            type="button"
            data-testid="settings-github-refresh"
            onClick={load}
            aria-label="Re-check GitHub sign-in"
            title="Re-check GitHub sign-in"
            className="cl-icon-button ml-auto h-6 w-6 shrink-0"
          >
            <RefreshIcon />
          </button>
        </span>
        {remediation && (
          <span className="mt-1 block text-xs" style={{ color: 'var(--text-muted)' }}>
            {remediation.line}
            <code className="mt-1 block select-all rounded px-2 py-1 text-[11px]" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {remediation.command}
            </code>
          </span>
        )}
        {/* Same size as the modal's other option descriptions — this line plays
            exactly that role for the status above it. */}
        <span className="mt-0.5 block text-xs" style={{ color: 'var(--text-muted)' }}>
          Signed in through GitHub CLI. Canary Lab does not store or manage your token.
        </span>
      </span>
    </div>
  )
}
