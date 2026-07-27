import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { GhStatus } from '@/shared/api/client'

// Read-only "which GitHub account is connected" surface (R80). Detect-and-
// instruct only: Canary never runs `gh auth login` and never handles the token
// — it reads gh's local status and, when something's off, shows the exact
// command the user runs themselves. Re-check on demand: auth changes outside
// the app, so the button re-fetches rather than trusting a cached value.
export function GitHubSection() {
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
    <div data-testid="settings-github" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: status?.authenticated ? 'var(--success)' : 'var(--text-muted)' }}
        />
        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {loading
            ? 'Checking…'
            : status?.authenticated
              ? `Connected${status.account ? ` as ${status.account}` : ''}${status.host && status.host !== 'github.com' ? ` (${status.host})` : ''}`
              : status?.installed ? 'Not signed in' : 'GitHub CLI not installed'}
        </span>
        <button type="button" data-testid="settings-github-refresh" onClick={load} className="cl-button ml-auto px-2 py-0.5 text-[11px]">
          Refresh
        </button>
      </div>
      {remediation && (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {remediation.line}
          <code className="mt-1 block select-all rounded px-2 py-1 text-[11px]" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            {remediation.command}
          </code>
        </div>
      )}
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        Canary only reads this — it never signs in for you or handles your token.
      </div>
    </div>
  )
}
