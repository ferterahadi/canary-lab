import { useEffect, useRef, useState } from 'react'
import * as workspaceApi from '@/shared/api/workspace'
import { FieldRow } from '@/shared/ui/FormFields'
import { BranchSuggestInput, branchSuggestions } from './BranchSuggestInput'
import { RepoSlice, deriveRepoName } from './repo-slice'
import { useRepoGitStatus } from '../state/use-repo-git-status'
import { RepoGitStatusNotice } from './RepoGitStatusNotice'
import { displayError } from '@/shared/api/error-message'
import { DisabledControlTooltip } from '@/shared/ui/Tooltip'

export function BranchControl({
  feature,
  repo,
  repoLookupName,
  localPathStr,
  isExpr,
  activeRun,
  onChange,
}: {
  feature: string
  repo: RepoSlice
  repoLookupName: string | undefined
  localPathStr: string
  isExpr: boolean
  activeRun: boolean
  onChange: (next: RepoSlice) => void
}) {
  const repoName = repoLookupName || repo.name || deriveRepoName(repo.localPath, repo.cloneUrl)
  const target = repo.branch ?? ''
  const enabled = Boolean(repoName && localPathStr && !isExpr)
  const { status, error, confirmed, refresh } = useRepoGitStatus(feature, repoName, { enabled, localPath: localPathStr })
  const identity = JSON.stringify([feature, repoName, localPathStr, isExpr])
  const [action, setAction] = useState<{ identity: string; switching: boolean; error: string | null } | null>(null)
  const switching = action?.identity === identity && action.switching
  const checkoutError = action?.identity === identity ? action.error : null
  const generation = useRef({ version: 0 })
  useEffect(() => {
    setAction(null)
    const lifetime = generation.current
    // A → B → A is still a different mounted target from the first A.
    return () => { lifetime.version++ }
  }, [identity])

  const loadStatus = (): void => { setAction(null); refresh() }
  const doCheckout = async (): Promise<void> => {
    if (!canSwitch) return
    const request = ++generation.current.version
    setAction({ identity, switching: true, error: null })
    let checkoutError: string | null = null
    try {
      await workspaceApi.checkoutRepoBranch(feature, repoName, target.trim())
    } catch (e) {
      checkoutError = displayError(e, 'Checkout failed')
    } finally {
      if (request === generation.current.version) {
        setAction({ identity, switching: false, error: checkoutError })
        refresh()
      }
    }
  }

  const canSwitch = Boolean(enabled && target.trim())
    && confirmed
    && status?.isGitRepo === true
    && !status.dirty
    && !activeRun
    && !switching
    && status.currentBranch !== target.trim()

  // Explain *why* Switch is disabled, surfaced as a hover tooltip.
  const switchDisabledReason: string | undefined = (() => {
    if (canSwitch || switching) return undefined
    if (!enabled) return 'Set a folder for this service first'
    if (!target.trim()) return 'Enter a branch name to switch to'
    if (!confirmed) return 'Waiting for current Git status'
    if (!status?.isGitRepo) return 'Not a git repository'
    if (status.dirty) {
      const n = status.dirtyFiles.length
      return `Commit or stash ${n} uncommitted ${n === 1 ? 'change' : 'changes'} to enable`
    }
    if (activeRun) return 'Disabled while this suite is running'
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
          <DisabledControlTooltip wrapperClassName="shrink-0 inline-flex">
            <button
              type="button"
              disabled={!canSwitch}
              title={switchDisabledReason}
              onClick={doCheckout}
              className="cl-button shrink-0 rounded-md px-2.5 py-1.5 text-[10px] uppercase tracking-wider"
            >
              {switching ? 'Switching…' : 'Switch'}
            </button>
          </DisabledControlTooltip>
          <button
            type="button"
            onClick={loadStatus}
            disabled={switching}
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
            Switch disabled while this suite is running
          </div>
        )}
        {enabled && <RepoGitStatusNotice status={status} confirmed={confirmed} error={error} />}
        {checkoutError && <div role="alert" className="text-[10px]" style={{ color: 'var(--danger)' }}>{checkoutError}</div>}
      </div>
    </FieldRow>
  )
}
