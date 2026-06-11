import { useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../../api/client'
import type { ConfigValue, ParsedConfigDoc } from '../../api/client'
import { SaveBar } from './SaveBar'
import { PortifyHistoryList } from '../PortifyHistoryList'
import { useEditableSlice } from './useEditableSlice'
import {
  deriveRepoName,
  parseRepo,
  serializeRepo,
  PortSlotEditor,
  type PortSlotSlice,
  type RepoSlice,
} from './ReposTab'

interface PortsSlice {
  repos: RepoSlice[]
}

/**
 * Dedicated home for a feature's injectable port slots — the one place to
 * declare them (the Service tab no longer edits ports inline) and to launch
 * Portify. Slots are nested per start-command per service, so this tab groups
 * by service → command and writes back into the same `repos[]` structure the
 * Service tab edits.
 */
export function PortsTab({
  feature,
  onStartPortify,
  onOpenPortify,
}: {
  feature: string
  onStartPortify?: (feature: string) => void
  /** Reopen a past/active port-ification workflow (by id) in the wizard. */
  onOpenPortify?: (workflowId: string) => void
}) {
  const ed = useEditableSlice<ParsedConfigDoc, PortsSlice>({
    load: () => api.getFeatureConfigDoc(feature),
    extract: (doc) => {
      const v = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const repos = Array.isArray(v.repos)
        ? v.repos.map(parseRepo).filter((r): r is RepoSlice => r != null)
        : []
      return { repos }
    },
    merge: (doc, slice) => {
      const current = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      return { ...current, repos: slice.repos.map(serializeRepo) }
    },
    save: (payload) => api.putFeatureConfigDoc(feature, payload as ConfigValue),
    deps: [feature],
  })
  const [confirmRerun, setConfirmRerun] = useState(false)

  if (ed.error && !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: 'var(--danger)' }}>{ed.error}</div>
  }
  if (ed.loading || !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  const { repos } = ed.draft

  // Shallow "portified" signal from the current (draft) config: any bootable
  // start command declares ≥1 slot — or there's nothing bootable to clash.
  // Mirrors the server's computePortPreflight, and updates live as slots change.
  const commands = repos.flatMap((r) => r.startCommands)
  const declaredSlots = commands.reduce((n, c) => n + (c.ports?.length ?? 0), 0)
  const portsConfigured = commands.length === 0 || declaredSlots > 0
  // Legend example: prefer a declared slot with both name and env var so the
  // strip explains the exact rows below; fall back to the scaffold default.
  const slots = commands.flatMap((c) => c.ports ?? [])
  const exampleSlot =
    slots.find((s) => s.name.trim() && s.env) ??
    slots.find((s) => s.name.trim()) ??
    { name: 'api', env: 'PORT' }
  const portifyBranch = `canary/dynamic-ports-${feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'feature'}`

  const launchPortify = (): void => {
    // Re-running on a feature that already has slots resets its branch — confirm.
    if (portsConfigured) setConfirmRerun(true)
    else onStartPortify?.(feature)
  }

  const setPorts = (ri: number, ci: number, ports: PortSlotSlice[]): void => {
    ed.setDraft((d) => ({
      repos: d.repos.map((r, i) =>
        i !== ri
          ? r
          : {
              ...r,
              startCommands: r.startCommands.map((c, j) =>
                j !== ci ? c : { ...c, ports: ports.length > 0 ? ports : undefined },
              ),
            },
      ),
    }))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {/* Intro band: what ports are for + the primary Portify action. The
            active tab already reads "Ports", so there's no redundant section
            title here — Portify is positioned as this tab's headline action,
            top-right of its own explanation. */}
        <div
          className="px-4 py-3"
          style={{
            borderBottom: '1px solid var(--border-default)',
            borderLeft: `2px solid ${portsConfigured ? 'rgb(52,211,153)' : 'color-mix(in srgb, var(--accent) 30%, var(--border-default))'}`,
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {/* Status leads: a glanceable headline + one-line meaning. */}
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block', width: 8, height: 8, borderRadius: 9999,
                    background: portsConfigured ? 'rgb(52,211,153)' : 'transparent',
                    border: portsConfigured ? 'none' : '1.5px solid var(--text-muted)',
                    boxShadow: portsConfigured ? '0 0 8px color-mix(in srgb, rgb(52,211,153) 55%, transparent)' : 'none',
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, color: portsConfigured ? 'rgb(52,211,153)' : 'var(--text-primary)' }}>
                  {portsConfigured ? 'Portified — ready for concurrent boot' : 'Not portified'}
                </span>
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)', maxWidth: 540 }}>
                {portsConfigured
                  ? 'Each service reads an injected port, so benchmark arms and parallel runs can boot this feature at once.'
                  : 'Booting this feature more than once would clash on a hardcoded port. Portify rewrites its listeners to injectable ports so it can.'}
              </p>
            </div>
            {onStartPortify && (
              <button
                type="button"
                onClick={launchPortify}
                className="shrink-0 inline-flex items-center gap-1.5 self-start rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors duration-150"
                title={portsConfigured
                  ? 'Re-run Portify — resets the dynamic-ports branch and redoes the rewrite.'
                  : 'Portify — detect and rewrite every listener to an injectable port automatically, so it can boot concurrently (benchmark arms / parallel runs).'}
                style={{
                  color: 'var(--accent)',
                  border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border-default))',
                  background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
                }}
              >
                <span aria-hidden>🔌</span>
                {portsConfigured ? 'Re-run Portify' : 'Portify'}
              </button>
            )}
          </div>

          {/* One-sentence legend keyed to this feature's own first slot, so it
              matches the rows it explains. (A collapsed prose explainer proved
              unreadable; a multi-stage chip diagram proved a mouthful.) */}
          <PortFlowLegend slot={exampleSlot} />
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
                    <PortSlotEditor
                      ports={cmd.ports ?? []}
                      onChange={(ports) => setPorts(ri, ci, ports)}
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

      <SaveBar
        dirty={ed.dirty}
        saving={ed.saving}
        error={ed.error}
        savedAt={ed.savedAt}
        onSave={ed.doSave}
        onDiscard={ed.discard}
      />

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
              <b style={{ color: 'var(--text-secondary)' }}>{feature}</b> already declares port slots. Re-running Portify resets the branch{' '}
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-secondary)' }}>{portifyBranch}</code>{' '}
              to HEAD and redoes the rewrite from scratch — any earlier commit on that branch is overwritten.
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
    </div>
  )
}

/**
 * One-sentence legend for the slot table, keyed to one of the feature's own
 * slots: assigned → injected → referenced. Depth lives in the column ⓘ hints;
 * this only has to make the three columns scannable.
 */
function PortFlowLegend({ slot }: { slot: PortSlotSlice }) {
  const name = slot.name.trim() || 'api'
  const chip = (text: string): ReactNode => (
    <code
      className="rounded px-1 py-px text-[10.5px]"
      style={{
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-secondary)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
      }}
    >
      {text}
    </code>
  )
  return (
    <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)', maxWidth: 640 }}>
      Each boot, {chip(name)} gets one free port.{' '}
      {slot.env ? (
        <>
          {chip(slot.env)} = {chip(`\${port.${name}}`)} are two names for that same number — the env
          var is what the service reads; the token is for everything else (start command, health
          check, envset files).
        </>
      ) : (
        <>Reference it as {chip(`\${port.${name}}`)} in the start command, health check, or envset files.</>
      )}
    </p>
  )
}
