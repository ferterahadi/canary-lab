import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import type { ConfigValue, PortifyManifest } from '@/shared/api/client'
import { ConfirmModal, Section, TrashIcon } from '@/shared/ui/atoms'
import { ReadOnlyBar } from './SaveBar'
import {
  isActivePortify,
  latestSavedWorkflowId,
  SavedOverlayPanel,
  usePortify,
} from '@/features/portify'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { useCachedDoc } from './config-doc-cache'
import { patchFileName } from '@shared/portify-overlay'
import { portInjectability, startCommandPortSlotCounts, type PortInjectability } from '@shared/launcher/port-injectability'
import {
  deriveRepoName,
  parseRepo,
  PortSlotTable,
  type RepoSlice,
} from './ReposTab'

/**
 * The frame every state of this tab shares: the inset scroller plus the footer
 * bar the writable tabs fill with their SaveBar. Loading, error, and loaded all
 * render through it, so the modal's bottom edge sits where it does on General /
 * Service / Envsets / Playwright instead of jumping when you switch to Ports.
 */
function PortsFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
        {children}
      </div>
      {/* Read-only, so no Save / Discard: this tab reports slots, it never
          writes them. The line says where they DO get written instead. */}
      <ReadOnlyBar>
        Read-only — slots are declared in
        {' '}
        <code style={{ fontFamily: 'var(--font-mono)' }}>feature.config.cjs</code>, by you or by Portify.
      </ReadOnlyBar>
    </div>
  )
}

/**
 * Read-only view of a feature's injectable port slots, with a route to the
 * Flight stage that owns Portify.
 * Slots are authored in the feature config file (services that read a port from
 * env) or by Portify (hardcoded-port services it rewrites) — never hand-edited
 * here. This tab shows them grouped by service → command and removes a saved
 * overlay; workflow actions route back to Flight.
 */
export function PortsTab({
  feature,
  portified = false,
  onOpenPortify,
}: {
  feature: string
  /** Whether a saved port overlay exists for this feature — overlay presence
   *  (the `overlayExists` check, via /api/features), NOT the declared-slot
   *  count. This is what "Portified" means: a verified overlay is on disk. */
  portified?: boolean
  /** Open this feature's Flight at Parallel setup. */
  onOpenPortify?: (feature: string) => void
}) {
  // Bumped when a portify overlay is saved so the slot table refetches the
  // rewritten config doc in place — without it the tab kept the pre-portify
  // slots until a remount (tab switch / refresh).
  const portsRefreshKey = useInvalidationKey('ports')
  // Read-only: this tab no longer writes config, so a plain read replaces the
  // editable-slice + SaveBar. The doc is the SAME one General + Service read, so
  // it comes from the dialog-scoped cache — switching tabs no longer refetches it.
  const cached = useCachedDoc(`config-doc:${feature}`, () => api.getFeatureConfigDoc(feature))
  const v = (cached.doc?.parsed.value ?? null) as { [k: string]: ConfigValue } | null
  const repos: RepoSlice[] | null = v == null
    ? null
    : Array.isArray(v.repos) ? v.repos.map(parseRepo).filter((r): r is RepoSlice => r != null) : []
  const loadError = cached.error
  // A portify save/removal rewrote the config file — evict the SHARED entry so
  // General and Service re-read it too, not just the tab that noticed. Held in a
  // ref because `cached` is a fresh object each render; the mount-time key is
  // the baseline, so this fires on every bump but never on first render.
  const refreshRef = useRef(cached.refresh)
  refreshRef.current = cached.refresh
  const mountedRefreshKey = useRef(portsRefreshKey)
  useEffect(() => {
    if (portsRefreshKey !== mountedRefreshKey.current) refreshRef.current()
  }, [portsRefreshKey])
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  // The latest saved overlay's workflow id — its manifest feeds the inline
  // overlay panel below (the diff + proof + per-service apply rows). Only the
  // live overlay matters here; the full record history + pruning live in the
  // Log Cleanup → Portify tab.
  const { workflows } = usePortify()
  const savedWorkflowId = latestSavedWorkflowId(workflows, feature)
  // Fetch the saved manifest so the overlay renders inline (verified state only).
  // The WS `details` map may not carry `.diff` for saved records, so getPortify
  // is the reliable source. `portified` is the verified gate — bandState below
  // is `'verified'` iff `portified` is true, and it's computed after the early
  // returns, so gate the fetch on the prop here.
  const [overlay, setOverlay] = useState<PortifyManifest | null>(null)
  const [overlayLoading, setOverlayLoading] = useState(false)
  useEffect(() => {
    if (!portified || !savedWorkflowId) { setOverlay(null); return }
    let cancelled = false
    setOverlay(null)
    setOverlayLoading(true)
    api.getPortify(savedWorkflowId)
      .then((m) => { if (!cancelled) setOverlay(m) })
      .catch(() => { if (!cancelled) setOverlay(null) })
      .finally(() => { if (!cancelled) setOverlayLoading(false) })
    return () => { cancelled = true }
  }, [portified, savedWorkflowId])
  // Live sync with every other Portify entry point (flight Parallel-readiness
  // stage, run-collision dialog, MCP): the `/ws/portify`-fed index is shared,
  // so an active workflow started ANYWHERE shows up here without a refresh.
  // Portify is single-flight — one active workflow total — so a run on another
  // feature blocks starting one here.
  const activeEntry = workflows.find((w) => isActivePortify(w.status))
  const activeHere = activeEntry?.feature === feature ? activeEntry : undefined
  const blockedBy = activeEntry && activeEntry.feature !== feature ? activeEntry : undefined

  if (loadError) {
    return <PortsFrame><div className="p-4 text-xs" style={{ color: 'var(--danger)' }}>{loadError}</div></PortsFrame>
  }
  if (repos === null) {
    return <PortsFrame><div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div></PortsFrame>
  }

  // The band reports INJECTABILITY with its evidence level, not portify status:
  // a feature whose services natively read their port from env declares slots
  // straight in feature.config.cjs and is concurrency-ready with no overlay at
  // all. Solid dot = machine-verified (overlay double-boot), hollow = declared.
  //   verified  — overlay exists (portified)
  //   declared  — every start command carries a slot, no overlay
  //   partial   — some commands have slots, others would still clash
  //   none      — no slots anywhere; Portify (or hand-declaring) is the way in
  const counts = startCommandPortSlotCounts(repos)
  const bandState: 'verified' | PortInjectability = portified ? 'verified' : portInjectability(repos)
  // Which services the saved overlay actually patched — used to fold the
  // "stored in" patch path into each repo card header (verified state only),
  // so the service list isn't enumerated a second time by SavedOverlayPanel.
  const overlayRepoNames = new Set((overlay?.repos ?? []).map((r) => r.name))

  const removePortification = async (): Promise<void> => {
    setRemoving(true)
    setRemoveError(null)
    try {
      await api.removePortifyOverlay(feature)
      // features-changed → App refetches /api/features → `portified` flips false
      // (status band updates live). Drop the cached config doc too: the file was
      // reverted, so every tab reading it must re-read to lose the removed slots.
      cached.refresh()
      setConfirmRemove(false)
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <>
      <PortsFrame>
        {/* Same inset card stack every other config tab uses (General, Service,
            Playwright): sibling Sections in a `flex flex-col gap-3 p-3` scroller,
            so no block bleeds to the modal edge. */}
        <div className="flex flex-col gap-3 p-3">
        {/* Status card: a glanceable Portified status in the header (headline +
            evidence dot) with the primary action in the header's right slot, and
            the explanation + saved overlay in the body. "Portified" = a saved
            overlay exists (overlay presence), not the declared-slot count.
            The old 2px state-coloured left edge is gone — a card is rounded on
            every side, and the dot + coloured headline already carry the state
            (same call the test card made when it dropped its left accent). */}
        <Section
          headerPadding="none"
          title={
            <span className="my-[10px] ml-[14px] flex items-center gap-2">
              {/* Dot fill carries the evidence level: solid = machine-verified
                  (double-boot), hollow = declared in config, unproven. */}
              <span
                aria-hidden
                className={activeHere ? 'cl-pulse' : undefined}
                style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: 9999,
                  background: activeHere ? 'var(--running)'
                    : bandState === 'verified' ? 'var(--success)'
                    : bandState === 'partial' ? 'var(--warning)'
                    : 'transparent',
                  border: activeHere || bandState === 'verified' || bandState === 'partial' ? 'none'
                    : bandState === 'declared' ? '1.5px solid var(--success)'
                    : '1.5px solid var(--text-muted)',
                  boxShadow: activeHere
                    ? '0 0 8px color-mix(in srgb, var(--running) 45%, transparent)'
                    : bandState === 'verified' ? '0 0 8px color-mix(in srgb, var(--success) 40%, transparent)' : 'none',
                }}
              />
              {/* No size/weight of its own — it inherits `Section`'s title type
                  (12px / medium) so this card heads the same as every other
                  config card (Envsets' "Env & slot", General's "Identity").
                  Only the colour is overridden, because that carries the state.
                  The header row's height is set by the taller right-slot button,
                  so the type change moves nothing. */}
              <span style={{ color: activeHere ? 'var(--running)' : bandState === 'verified' ? 'var(--success)' : 'var(--text-primary)' }}>
                {activeHere
                  ? (activeHere.status === 'ready-to-save' ? 'Portify — ready to save' : 'Portify in progress')
                  : bandState === 'verified' ? 'Portified — boots concurrently'
                  : bandState === 'declared' ? 'Injectable — declared in config'
                  : bandState === 'partial' ? `Partially injectable — ${counts.slotted} of ${counts.total} start commands have slots`
                  : 'Not injectable — no port slots declared'}
              </span>
            </span>
          }
          right={
            <div className="mr-[14px] flex shrink-0 items-center gap-2">
            {/* Portify is owned by the Flight stage. An active workflow keeps
                the same one-click entry, but it lands on Parallel setup where
                progress and review live with the rest of the pipeline. */}
            {activeHere && onOpenPortify && (
              <button
                type="button"
                onClick={() => onOpenPortify(feature)}
                title={activeHere.status === 'ready-to-save'
                  ? 'Open the parked review — inspect the rewrite diff and save the overlay.'
                  : 'Open Parallel setup in Flight to follow its progress.'}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150"
                style={{
                  color: 'var(--running)',
                  border: '1px solid color-mix(in srgb, var(--running) 45%, var(--border-default))',
                  background: 'color-mix(in srgb, var(--running) 8%, transparent)',
                }}
              >
                {activeHere.status === 'ready-to-save' ? 'Review in Flight' : 'View in Flight'}
              </button>
            )}
            {/* The saved overlay stays inline below the band for configuration
                reference. Workflow ownership and actions live in Flight. */}
            {/* Verified → undo the whole port-ification (overlay + config).
                Re-portifying is the sanctioned two-step: Remove, then the band
                offers Portify again. (No "Clear port slots": the UI can't tell
                real declared slots from orphans — config edits stay in
                feature.config.cjs, where the caption points.) */}
            {!activeHere && bandState === 'verified' && (
              <button
                type="button"
                onClick={() => { setRemoveError(null); setConfirmRemove(true) }}
                aria-label="Remove portification"
                title="Deletes the saved overlay and restores the config; the suite reverts to its fixed ports."
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150"
                style={{
                  color: 'var(--danger)',
                  border: '1px solid color-mix(in srgb, var(--danger) 40%, var(--border-default))',
                  background: 'transparent',
                }}
              >
                <TrashIcon />
                Remove portification
              </button>
            )}
            {/* Portify: the accent CTA only where it's the way in (none /
                partial). A fully declared feature keeps a demoted ghost —
                optional, but the recovery door if a service ignores its env
                var. Verified features have no start button at all. */}
            {!activeHere && bandState !== 'verified' && onOpenPortify && (
              <button
                type="button"
                onClick={() => onOpenPortify(feature)}
                disabled={blockedBy != null}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-[11px] font-medium transition-colors duration-150"
                title={blockedBy
                  ? `Portify runs one workflow at a time — ${blockedBy.feature} is currently portifying.`
                  : bandState === 'declared'
                  ? 'Optional — slots are already declared. Run it if a service ignores its env var and needs its listener rewritten.'
                  : 'Open Parallel setup in Flight to make the suite concurrency-ready.'}
                style={bandState === 'declared'
                  ? {
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border-default)',
                      background: 'transparent',
                      opacity: blockedBy ? 0.5 : undefined,
                      cursor: blockedBy ? 'not-allowed' : undefined,
                    }
                  : {
                      color: 'var(--accent)',
                      border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border-default))',
                      background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
                      opacity: blockedBy ? 0.5 : undefined,
                      cursor: blockedBy ? 'not-allowed' : undefined,
                    }}
              >
                Open in Flight
              </button>
            )}
            </div>
          }
        >
          {/* Active workflow (started here, from a flight, or by an agent) owns
              the card; every resting state carries its own explanation. */}
          <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)', maxWidth: 560 }}>
            {activeHere
              ? (activeHere.status === 'ready-to-save'
                ? 'The rewrite is verified and parked for review. Open it to review the diff and save the overlay.'
                : 'A port-ification workflow is running for this suite — it may have been started from a flight or by an agent. Open it to follow along.')
              : bandState === 'verified'
              ? 'Rewritten by the agent, applied as an overlay each run.'
              : bandState === 'declared'
              ? 'Every start command declares a port slot; Canary injects a free port through its env var at boot. Declared, not agent-verified — proven live whenever the suite boots twice.'
              : bandState === 'partial'
              ? 'Commands without a slot keep their fixed ports — two boots would clash there. Portify can cover the remaining commands.'
              : 'Concurrent boots would clash on fixed ports. Portify rewrites listeners to read injected ports and saves the diff as an overlay — the repo itself is never modified.'}
          </p>

          {/* Verified → the saved overlay renders in this same card, under the
              status it belongs to (the diff, the open-in-editor control, the
              stored-in path folded into the slot cards' headers, and the
              double-boot proof). Only rendered when a saved record backs it — a
              pruned record leaves the status + slot cards as before. */}
          {bandState === 'verified' && (overlayLoading || overlay) && (
            <div className="mt-3">
              {overlay
                ? <SavedOverlayPanel manifest={overlay} collapsibleDiff showServiceTable={false} />
                : <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading overlay…</div>}
            </div>
          )}
        </Section>

        <Section title="Port slots" bodyClassName="px-3.5 py-3 flex flex-col gap-3">
          {/* The slot explainer — what a slot IS, and where slots live
              (feature.config.cjs — also the escape hatch for editing or removing
              hand-declared ones). Lives inside the card it explains. Skipped in
              the verified state: the status card's overlay panel above already
              explains how ports get injected. */}
          {bandState !== 'verified' && (
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)', maxWidth: 640 }}>
              A slot is a port Canary picks free at each boot and hands the service through its env var; {'${port.<name>}'} resolves to that number in commands and health checks. Slots are declared in feature.config.cjs — by you, or by Portify.
            </p>
          )}

          {repos.length === 0 && (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              No services configured. Add services in the Service tab first.
            </div>
          )}

          {repos.map((repo, ri) => {
            const repoName = repo.name || deriveRepoName(repo.localPath, repo.cloneUrl) || '(unnamed service)'
            // Show where this service's patch lives right in the header, but only
            // when the overlay actually patched it (verified state) — folds in
            // what SavedOverlayPanel's per-service table used to carry.
            const patchFile = bandState === 'verified' && overlayRepoNames.has(repoName)
              ? patchFileName(repoName)
              : null
            return (
            <div
              key={ri}
              className="rounded-md"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
            >
              <header
                className="flex items-center justify-between gap-2 px-3 py-2"
                style={{ borderBottom: '1px solid var(--border-default)' }}
              >
                {/* Same row-label size as the Service tab's repo card — a repo
                    name inside the dialog is not a dialog title. */}
                <span className="truncate text-[12.5px] font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                  {repoName}
                </span>
                {patchFile && (
                  <span
                    className="shrink-0 truncate text-[10px]"
                    style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', maxWidth: '55%' }}
                    title="Stored inside your canary workspace — not the product repo"
                  >
                    ↳ portify/{patchFile}
                  </span>
                )}
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
                      // Always the same neutral empty state — the band + caption
                      // carry the pitch and the one action. (The PortSlotTable
                      // default asserts "uses its hardcoded port; can't run
                      // concurrently", which the UI can't actually know — a
                      // command may open no port at all.)
                      emptyHint={
                        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>No port slots declared</div>
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
            )
          })}
        </Section>
        </div>
      </PortsFrame>

      <ConfirmModal
        open={confirmRemove}
        title="Remove portification?"
        message={
          <div className="space-y-2">
            <p>
              This reverts the port-ification of <code style={{ fontFamily: 'var(--font-mono)' }}>{feature}</code>: the code overlay is deleted and its <code style={{ fontFamily: 'var(--font-mono)' }}>feature.config.cjs</code> edits (the port slots and <code style={{ fontFamily: 'var(--font-mono)' }}>{'${port.…}'}</code> health-check URLs) are restored to how they were before. It boots on its fixed ports again and can no longer run concurrently.
            </p>
            <p style={{ color: 'var(--text-muted)' }}>
              Your product repo is untouched. To re-derive the overlay from current source, remove it and run Portify again — the band offers it as soon as this completes. Until a new overlay is saved, the suite can&apos;t boot concurrently.
            </p>
            {removeError && <p style={{ color: 'var(--danger)' }}>{removeError}</p>}
          </div>
        }
        confirmLabel="Remove portification"
        variant="danger"
        busy={removing}
        onCancel={() => { if (!removing) { setConfirmRemove(false); setRemoveError(null) } }}
        onConfirm={removePortification}
      />
    </>
  )
}
