import { useEffect, useState } from 'react'
import * as api from '../../../shared/api/client'
import type { ConfigValue } from '../../../shared/api/client'
import { ConfirmModal, TrashIcon } from './atoms'
import { PortifyHistoryList } from '../../portify/components/PortifyHistoryList'
import {
  deriveRepoName,
  parseRepo,
  PortSlotTable,
  type RepoSlice,
} from './ReposTab'

/**
 * Read-only view of a feature's injectable port slots, and the home for Portify.
 * Slots are authored in the feature config file (services that read a port from
 * env) or by Portify (hardcoded-port services it rewrites) — never hand-edited
 * here. This tab shows them grouped by service → command and launches / removes
 * Portify.
 */
export function PortsTab({
  feature,
  portified = false,
  portsRefreshKey,
  onStartPortify,
  onOpenPortify,
}: {
  feature: string
  /** Whether a saved port overlay exists for this feature — overlay presence
   *  (the `overlayExists` check, via /api/features), NOT the declared-slot
   *  count. This is what "Portified" means: a verified overlay is on disk. */
  portified?: boolean
  /** Bumped by App when a portify overlay is saved. Added to the load deps so
   *  the slot table refetches the rewritten config doc in place — without it the
   *  tab kept the pre-portify slots until a remount (tab switch / refresh). */
  portsRefreshKey?: number
  onStartPortify?: (feature: string) => void
  /** Reopen a past/active port-ification workflow (by id) in the wizard. */
  onOpenPortify?: (workflowId: string) => void
}) {
  // Read-only: this tab no longer writes config, so a plain fetch replaces the
  // editable-slice + SaveBar. Refetches when portsRefreshKey is bumped (a portify
  // save / removal rewrote the slots) so the table reflects it without a remount.
  const [repos, setRepos] = useState<RepoSlice[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Bumped after un-portify reverts the config, so the slot table refetches the
  // reverted file in place (features-changed only refreshes the feature list).
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    setRepos(null)
    setLoadError(null)
    api.getFeatureConfigDoc(feature)
      .then((doc) => {
        if (cancelled) return
        const v = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
        setRepos(Array.isArray(v.repos) ? v.repos.map(parseRepo).filter((r): r is RepoSlice => r != null) : [])
      })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Load failed') })
    return () => { cancelled = true }
  }, [feature, portsRefreshKey, reloadKey])
  const [confirmRerun, setConfirmRerun] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  if (loadError) {
    return <div className="p-4 text-xs" style={{ color: 'var(--danger)' }}>{loadError}</div>
  }
  if (repos === null) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  const launchPortify = (): void => {
    // An already-portified feature re-runs (refreshing its overlay) behind a
    // confirm; a fresh one starts directly.
    if (portified) setConfirmRerun(true)
    else onStartPortify?.(feature)
  }

  // Declared slots with no overlay = orphaned config (leftover from a removed
  // portification, or hand-declared). When not portified, this is the only
  // signal that there's port config to clear.
  const hasSlots = repos.some((r) => r.startCommands.some((c) => (c.ports?.length ?? 0) > 0))

  const removePortification = async (): Promise<void> => {
    setRemoving(true)
    setRemoveError(null)
    try {
      await api.removePortifyOverlay(feature)
      // features-changed → App refetches /api/features → `portified` flips false
      // (status band updates live). Bump reloadKey too: the config was reverted,
      // so the slot table must refetch to drop the now-removed slots.
      setReloadKey((k) => k + 1)
      setConfirmRemove(false)
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setRemoving(false)
    }
  }


  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {/* Intro band: a glanceable Portified status + the primary action.
            "Portified" = a saved overlay exists (overlay presence), not the
            declared-slot count. Deliberately minimal — the slot table below and
            its column ⓘ hints carry the detail. */}
        <div
          className="flex items-center justify-between gap-4 px-4 py-3"
          style={{
            borderBottom: '1px solid var(--border-default)',
            borderLeft: `2px solid ${portified ? 'rgb(52,211,153)' : 'color-mix(in srgb, var(--accent) 30%, var(--border-default))'}`,
          }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: 9999,
                  background: portified ? 'rgb(52,211,153)' : 'transparent',
                  border: portified ? 'none' : '1.5px solid var(--text-muted)',
                  boxShadow: portified ? '0 0 8px color-mix(in srgb, rgb(52,211,153) 55%, transparent)' : 'none',
                }}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: portified ? 'rgb(52,211,153)' : 'var(--text-primary)' }}>
                {portified ? 'Portified — boots concurrently' : 'Not portified'}
              </span>
            </div>
            {/* Only the not-portified state needs a prompt; the badge says the rest. */}
            {!portified && (
              <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)', maxWidth: 560 }}>
                Booting this feature twice would clash on a hardcoded port. Portify rewrites its listeners to injectable ports and saves the change as an overlay — your repo is never modified.
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 self-start">
            {/* Portified → undo the whole port-ification (overlay + config).
                Not portified but slots are still declared → those are orphaned
                config (a removed portification, or hand-declared); offer to
                clear them. Both go through the same revert path. */}
            {(portified || hasSlots) && (
              <button
                type="button"
                onClick={() => { setRemoveError(null); setConfirmRemove(true) }}
                aria-label={portified ? 'Remove portification' : 'Clear port slots'}
                title={portified
                  ? 'Remove portification — deletes the saved overlay; the feature reverts to its hardcoded ports.'
                  : 'Clear port slots — removes the declared slots left in the config (e.g. from a removed portification).'}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors duration-150"
                style={{
                  color: 'var(--danger)',
                  border: '1px solid color-mix(in srgb, var(--danger) 40%, var(--border-default))',
                  background: 'transparent',
                }}
              >
                <TrashIcon />
                {portified ? 'Remove portification' : 'Clear port slots'}
              </button>
            )}
            {onStartPortify && (
              <button
                type="button"
                onClick={launchPortify}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors duration-150"
                title={portified
                  ? 'Re-run Portify — re-derives the overlay from the current source.'
                  : 'Portify — rewrite every listener to an injectable port so it can boot concurrently.'}
                style={{
                  color: 'var(--accent)',
                  border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border-default))',
                  background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
                }}
              >
                <span aria-hidden>🔌</span>
                {portified ? 'Re-run Portify' : 'Portify'}
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          {repos.length === 0 && (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              No services configured. Add services in the Service tab first.
            </div>
          )}

          {repos.map((repo, ri) => (
            <div
              key={ri}
              className="rounded-md"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
            >
              <header
                className="flex items-center gap-2 px-3 py-2"
                style={{ borderBottom: '1px solid var(--border-default)' }}
              >
                <span className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                  {repo.name || deriveRepoName(repo.localPath, repo.cloneUrl) || '(unnamed service)'}
                </span>
              </header>

              <div className="flex flex-col gap-3 px-3 py-2.5">
                {repo.startCommands.length === 0 && (
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    No start commands. Add one in the Service tab.
                  </div>
                )}
                {repo.startCommands.map((cmd, ci) => (
                  <div key={ci} className="flex flex-col gap-1.5">
                    <div
                      className="truncate text-[11px]"
                      style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
                      title={cmd.command}
                    >
                      <span style={{ color: 'var(--text-muted)' }}>▸ </span>
                      {cmd.command || cmd.name || '(unnamed command)'}
                    </div>
                    <PortSlotTable
                      ports={cmd.ports ?? []}
                      // Not-portified empty state: a single neutral status, no
                      // pitch and no per-card CTA — the intro band already
                      // explains Portify and carries the one action. (Don't say
                      // "hardcoded" — the command may already carry a ${port.x}
                      // token; "no slots declared" is what's actually true.)
                      emptyHint={!portified ? (
                        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>No port slots declared</div>
                      ) : undefined}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* This feature's Portify history. Lives here — where Portify is
            launched — so a committed run's branch stays findable after its
            window is closed. */}
        <div className="px-4 py-3" style={{ borderTop: '1px solid var(--border-default)' }}>
          <PortifyHistoryList feature={feature} onOpenPortify={onOpenPortify} />
        </div>
      </div>

      {confirmRerun && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', zIndex: 95 }}
          onClick={() => setConfirmRerun(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Re-run Portify"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(460px, 92%)', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: 20 }}
          >
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Re-run Portify?</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16 }}>
              <b style={{ color: 'var(--text-secondary)' }}>{feature}</b> already has a saved overlay. Re-running Portify re-derives it from the current source — the saved overlay is replaced when you save again. Nothing is committed to your repo.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="cl-button" onClick={() => setConfirmRerun(false)} style={{ padding: '7px 14px', fontSize: 12.5 }}>Cancel</button>
              <button
                type="button"
                className="cl-button-primary"
                onClick={() => { setConfirmRerun(false); onStartPortify?.(feature) }}
                style={{ padding: '7px 14px', fontSize: 12.5 }}
              >
                Re-run Portify
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmRemove}
        title={portified ? 'Remove portification?' : 'Clear port slots?'}
        message={
          <div className="space-y-2">
            {portified ? (
              <p>
                This reverts the port-ification of <code style={{ fontFamily: 'var(--font-mono)' }}>{feature}</code>: the code overlay is deleted and its <code style={{ fontFamily: 'var(--font-mono)' }}>feature.config.cjs</code> edits (the port slots and <code style={{ fontFamily: 'var(--font-mono)' }}>{'${port.…}'}</code> health-check URLs) are restored to how they were before. It boots on its hardcoded ports again and can no longer run concurrently.
              </p>
            ) : (
              <p>
                This removes the declared <code style={{ fontFamily: 'var(--font-mono)' }}>ports</code> slots left in <code style={{ fontFamily: 'var(--font-mono)' }}>{feature}</code>'s config — orphaned leftovers from a removed portification. The feature isn't portified, so nothing else changes.
              </p>
            )}
            <p style={{ color: 'var(--text-muted)' }}>
              {portified
                ? 'Your product repo is untouched. Re-run Portify any time to regenerate it.'
                : "Your product repo is untouched. Skip this if a service genuinely reads these env vars — then the slots aren't orphaned. Re-run Portify any time to set them up properly."}
            </p>
            {removeError && <p style={{ color: 'var(--danger)' }}>{removeError}</p>}
          </div>
        }
        confirmLabel={portified ? 'Remove portification' : 'Clear port slots'}
        variant="danger"
        busy={removing}
        onCancel={() => { if (!removing) { setConfirmRemove(false); setRemoveError(null) } }}
        onConfirm={removePortification}
      />
    </div>
  )
}
