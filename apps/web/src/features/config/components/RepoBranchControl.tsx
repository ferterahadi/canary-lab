import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import { FieldRow } from '@/shared/ui/atoms'
import { BranchSuggestInput, branchSuggestions } from './BranchSuggestInput'
import { RepoSlice, deriveRepoName } from './repo-slice'

export function BranchControl({
  feature,
  repo,
  repoLookupName,
  localPathStr,
  isExpr,
  activeRun,
  onChange,
  refreshKey,
}: {
  feature: string
  repo: RepoSlice
  repoLookupName: string | undefined
  localPathStr: string
  isExpr: boolean
  activeRun: boolean
  onChange: (next: RepoSlice) => void
  refreshKey?: number
}) {
  const [status, setStatus] = useState<api.GitRepoStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [switchHovered, setSwitchHovered] = useState(false)
  const repoName = repoLookupName || repo.name || deriveRepoName(repo.localPath, repo.cloneUrl)
  const target = repo.branch ?? ''

  const loadStatus = (): void => {
    if (!repoName || isExpr || !localPathStr) {
      setStatus(null)
      setError(null)
      return
    }
    api.getRepoGitStatus(feature, repoName)
      .then((next) => {
        setStatus(next)
        setError(null)
      })
      .catch((e: unknown) => {
        setStatus(null)
        setError(e instanceof Error ? e.message : 'Failed to load git status')
      })
  }

  useEffect(() => {
    let cancelled = false
    if (!repoName || isExpr || !localPathStr) {
      setStatus(null)
      setError(null)
      return
    }
    api.getRepoGitStatus(feature, repoName)
      .then((next) => {
        if (cancelled) return
        setStatus(next)
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setStatus(null)
        setError(e instanceof Error ? e.message : 'Failed to load git status')
      })
    return () => { cancelled = true }
    // refreshKey bumps on `features-changed` (e.g. an MCP/other-tab branch checkout)
    // → re-pull git status so the displayed branch is never stale.
  }, [feature, repoName, isExpr, localPathStr, refreshKey])

  const doCheckout = async (): Promise<void> => {
    const branch = target.trim()
    if (!repoName || !branch) return
    setSwitching(true)
    setError(null)
    try {
      const next = await api.checkoutRepoBranch(feature, repoName, branch)
      setStatus(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed')
    } finally {
      setSwitching(false)
    }
  }

  const canSwitch = Boolean(repoName && target.trim())
    && status?.isGitRepo === true
    && !status.dirty
    && !activeRun
    && !switching
    && status.currentBranch !== target.trim()

  // Explain *why* Switch is disabled, surfaced as a native hover tooltip.
  const switchDisabledReason: string | undefined = (() => {
    if (canSwitch || switching) return undefined
    if (!repoName) return 'Set a folder for this service first'
    if (!target.trim()) return 'Enter a branch name to switch to'
    if (!status?.isGitRepo) return 'Not a git repository'
    if (status.dirty) {
      const n = status.dirtyFiles.length
      return `Commit or stash ${n} uncommitted ${n === 1 ? 'change' : 'changes'} to enable`
    }
    if (activeRun) return 'Disabled while this feature is running'
    if (status.currentBranch === target.trim()) return 'Already on this branch'
    return undefined
  })()

  return (
    <FieldRow label="Branch" hint="Optional branch Canary Lab expects before starting this repo's services.">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <BranchSuggestInput
            value={target}
            branches={branchSuggestions(status)}
            placeholder={status?.currentBranch ?? 'feature/my-branch'}
            onChange={(next) => onChange({ ...repo, branch: next || undefined })}
            inputClassName="w-full rounded-md px-2.5 py-1.5 text-xs outline-none"
            inputStyle={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
            }}
          />
          {/* Custom tooltip driven by React state — Tailwind JIT didn't pick up
              group-hover utilities, and native title tooltips don't fire on
              disabled buttons. State-driven render is bulletproof. */}
          <span
            className="relative shrink-0 inline-flex"
            style={{ cursor: switchDisabledReason ? 'help' : 'default' }}
            onMouseEnter={() => setSwitchHovered(true)}
            onMouseLeave={() => setSwitchHovered(false)}
          >
            <button
              type="button"
              disabled={!canSwitch}
              onClick={doCheckout}
              className="cl-button rounded-md px-2.5 py-1.5 text-[10px] uppercase tracking-wider"
              style={{
                pointerEvents: canSwitch || switching ? undefined : 'none',
              }}
            >
              {switching ? 'Switching…' : 'Switch'}
            </button>
            {switchHovered && switchDisabledReason && (
              <span
                role="tooltip"
                className="cl-popover pointer-events-none absolute left-1/2 bottom-[calc(100%+6px)] -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-[10px]"
                style={{
                  color: 'var(--text-primary)',
                  zIndex: 60,
                }}
              >
                {switchDisabledReason}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={loadStatus}
            aria-label="Refresh git status"
            title="Refresh git status"
            className="cl-button shrink-0 inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs leading-none"
          >
            ↻
          </button>
        </div>
        {status?.isGitRepo && status.dirty && status.dirtyFiles.length > 0 && (
          <div className="text-[10px]" style={{ color: 'var(--warning)', fontFamily: 'var(--font-mono)' }}>
            {status.dirtyFiles.length} uncommitted
          </div>
        )}
        {activeRun && (
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Switch disabled while this feature is running
          </div>
        )}
        {error && <div className="text-[10px]" style={{ color: 'var(--danger)' }}>{error}</div>}
      </div>
    </FieldRow>
  )
}
