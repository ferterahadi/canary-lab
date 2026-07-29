import { useCallback, useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { FlightStageStatus } from '@/shared/api/client'
import type { FeatureDocsListing } from '@/shared/api/types'
import { DocPill, readAsBase64 } from '@/features/coverage/components/CoverageDocsRail'
import { PANEL_CARD_CLASS, PANEL_CARD_STYLE } from '@/shared/ui/PanelCard'
import { STAGE_COLUMN, StageStatusChip } from './stage-meta'
import { PANEL_KICKER_CLASS } from './RepoScanPanel'
import { SkeletonLines, SkeletonRows, type AwaitingState } from '@/shared/ui/Skeleton'

// ─── Requirements (R74): the two-path fork + the resting docs panel ──────────
// While the flight is parked on the prd-source checkpoint the FORK owns the
// surface: "I'll add docs myself" (drop zone, no agent) vs "Let the agent find
// them" (two intent-guided hints — collect docs from the repos / infer from
// the git diff — that spawn the server collector; its output streams in the
// stage's activity band). Outside the checkpoint the panel is a read-only
// lens: pills + the summary chip, locked once approved — changes go through
// Continue → from a step → Requirements.

/** Doc CRUD over a feature's docs/ folder — one loader shared by the fork's
 *  manual path and the resting panel (same REST the coverage rail uses). */
export function useFlightDocs(feature: string, refreshKey?: number, onChanged?: () => void) {
  const [listing, setListing] = useState<FeatureDocsListing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((keepError = false) => {
    api.listFeatureDocs(feature)
      .then((data) => { setListing(data); if (!keepError) setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [feature])
  useEffect(() => { load() }, [load, refreshKey])

  const importFiles = useCallback(async (files: FileList) => {
    setBusy(true)
    setError(null)
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        const base64 = await readAsBase64(file)
        await api.importFeatureDoc(feature, { filename: file.name, contentType: file.type || undefined, base64 })
      } catch (e: unknown) {
        failures.push(`${file.name} (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    if (failures.length > 0) setError(`import failed: ${failures.join(', ')}`)
    load(failures.length > 0)
    onChanged?.()
    setBusy(false)
  }, [feature, load, onChanged])

  const removeDoc = useCallback((relPath: string) => {
    setBusy(true)
    api.deleteFeatureDoc(feature, relPath)
      .then(() => { load(); onChanged?.() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [feature, load, onChanged])

  const openDoc = useCallback((absPath: string) => {
    api.openEditor({ file: absPath }).catch(() => {})
  }, [])

  const sourceDocs = (listing?.docs ?? []).filter((d) => !d.generated)
  // The distilled artifact (_prd-summary.md/.json) — the stage's actual OUTPUT.
  // Filtered out of the source list on purpose; it gets its own card.
  const generatedDocs = (listing?.docs ?? []).filter((d) => d.generated)
  return { sourceDocs, generatedDocs, busy, error, importFiles, removeDoc, openDoc }
}

/** The resting Requirements panel — a read-only lens on docs/ while the stage
 *  runs or after it settles. No add/remove affordances here: while parked the
 *  fork owns editing; once approved the set is honestly frozen.
 *
 *  Two cards, because the stage has two halves the user thinks about
 *  separately: the source docs that went IN, and the distilled summary that
 *  came OUT. Before, only the inputs had a card and the output existed solely
 *  as a 10px "Summary ✓" chip — the stage's actual deliverable was the one
 *  thing you couldn't see or open. The summary chip now rides the output card
 *  it describes, so neither card reports the other's status. */
export function FlightDocsPanel({
  feature,
  approved,
  refreshKey,
  summaryStatus,
  requirementCount,
  awaiting,
}: {
  feature: string
  /** Stage settled done — requirements approved, the doc set is frozen. */
  approved: boolean
  /** Bumped on coverage-changed so out-of-band doc writes show live. */
  refreshKey?: number
  /** The folded prd-summary stage's status — chips the distilled card. */
  summaryStatus?: FlightStageStatus
  /** Live requirement count from the folded prd-summary's evidence. */
  requirementCount?: number
  /** R83: the stage hasn't settled — an empty half renders as its skeleton
   *  rather than as a flat "none" sentence, which reads as a finding. */
  awaiting?: AwaitingState
}) {
  const docs = useFlightDocs(feature, refreshKey)
  const showDistilled = summaryStatus !== undefined && summaryStatus !== 'pending'
  return (
    <section data-testid="flight-docs-panel" className={`flex flex-col gap-2.5 ${STAGE_COLUMN}`}>
      <div className={PANEL_CARD_CLASS} style={PANEL_CARD_STYLE}>
        <div className="flex items-center gap-2">
          <div className={PANEL_KICKER_CLASS}>
            {docs.sourceDocs.length > 0 ? `Requirement docs · ${docs.sourceDocs.length}` : 'Requirement docs'}
          </div>
          <div className="flex-1" />
          {approved && (
            <span
              data-testid="docs-locked-chip"
              className="mb-1 rounded border px-1.5 py-px text-[9.5px] font-medium text-muted border-line"
            >
              Locked — approved
            </span>
          )}
        </div>
        {docs.sourceDocs.length === 0 ? (
          awaiting
            ? <SkeletonRows awaiting={awaiting} rows={2} sub={false} />
            : <div className="text-[11px] text-muted">No source docs.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {docs.sourceDocs.map((d) => (
              <DocPill
                key={d.relPath}
                relPath={d.relPath}
                dirPrefix={`features/${feature}/docs/`}
                generated={d.generated}
                sizeBytes={d.sizeBytes}
                linked={d.linked}
                linkTarget={d.linkTarget}
                broken={d.broken}
                busy={false}
                onOpen={() => docs.openDoc(d.absPath)}
                removeTitle="Remove doc"
              />
            ))}
          </div>
        )}
        {approved && (
          <p className="mt-2 text-[10.5px] text-muted">
            To change these, use Continue → from a step → Requirements — later results are discarded from that point.
          </p>
        )}
        {docs.error && <div className="mt-2 text-[11px] text-danger">{docs.error}</div>}
      </div>

      {/* The output half. Rendered from `summaryStatus` alone (not from the
          artifact existing) so the running state has a card too — otherwise
          the panel is a blank gap for the whole distillation, which is the
          longest part of the stage. */}
      {(showDistilled || awaiting) && (
        <div className={PANEL_CARD_CLASS} style={PANEL_CARD_STYLE} data-testid="flight-distilled-panel">
          <div className="flex items-center gap-2">
            <div className={PANEL_KICKER_CLASS}>
              {requirementCount != null ? `Distilled requirements · ${requirementCount}` : 'Distilled requirements'}
            </div>
            <div className="flex-1" />
            {summaryStatus && (
              <span className="mb-1 flex items-center gap-1.5 text-[10px] text-muted" data-testid="docs-summary-chip">
                Summary
                <StageStatusChip status={summaryStatus} />
              </span>
            )}
          </div>

          {docs.generatedDocs.length > 0 ? (
            <div className="flex flex-col gap-2">
              {docs.generatedDocs.map((d) => (
                <DocPill
                  key={d.relPath}
                  relPath={d.relPath}
                  dirPrefix={`features/${feature}/docs/`}
                  generated={d.generated}
                  sizeBytes={d.sizeBytes}
                  linked={d.linked}
                  linkTarget={d.linkTarget}
                  broken={d.broken}
                  busy={false}
                  onOpen={() => docs.openDoc(d.absPath)}
                  removeTitle="Remove doc"
                />
              ))}
            </div>
          ) : awaiting && summaryStatus !== 'running' && summaryStatus !== 'failed' ? (
            <SkeletonLines awaiting={awaiting} rows={2} />
          ) : (
            <div className="text-[11px] text-muted">
              {summaryStatus === 'running'
                ? 'Distilling the source docs into requirements — the agent’s progress is in Activity below.'
                : summaryStatus === 'failed'
                  ? 'Distillation failed before writing a summary — see Activity below.'
                  : 'No summary artifact on disk.'}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** The folded intent row — one truncated line, View/Fold to expand. The intent
 *  is frozen and guides both fork paths, so it rides every fork state. */
export function IntentRow({ description }: { description: string }) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      data-testid="fork-intent"
      onClick={() => setOpen(!open)}
      className="flex w-full cursor-pointer items-center gap-2 rounded border border-line bg-transparent px-2.5 py-1.5 text-left"
      title={open ? 'Fold the intent' : 'View the full intent'}
    >
      <span className="cl-rubric shrink-0">
        Intent
      </span>
      {/* Prose, not code — the intent reads in the app face like every other
          sentence on the page (mono stays reserved for paths/commands). */}
      <span
        data-testid="fork-intent-text"
        className={`min-w-0 flex-1 text-[12px] text-secondary ${open ? 'leading-relaxed' : 'truncate'}`}
      >
        {description}
      </span>
      <span className="shrink-0 text-[10.5px] text-accent">
        {open ? 'Fold' : 'View'}
      </span>
    </button>
  )
}

/** One fork path card — a radio-like affordance that STAYS visible after the
 *  pick (R74 polish): the selected card lights sky + shows its dot filled, the
 *  other dims but remains clickable, so the previous choice is never hidden. */
export function ForkPathCard({ testId, title, blurb, recommended, note, selected, dimmed, disabled, onPick }: {
  testId: string
  title: string
  blurb: string
  recommended?: boolean
  /** Neutral status chip (e.g. "Tried · empty") — states what happened on this
   *  path without the sky accent that marks a recommendation. */
  note?: string
  /** This card is the current pick — its content renders below the pair. */
  selected?: boolean
  /** A sibling is selected — recede without disappearing. */
  dimmed?: boolean
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      role="radio"
      aria-checked={Boolean(selected)}
      disabled={disabled}
      onClick={onPick}
      /* Neutral surfaces — the accent lives in the border + radio dot only. */
      className={[
        'relative flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-md border p-3 text-left transition-all',
        selected ? 'border-accent/60 bg-selected' : 'border-line bg-transparent',
        dimmed ? 'opacity-60' : '',
      ].filter(Boolean).join(' ')}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-accent' : 'border-line'}`}
      >
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold">
          {title}
          {recommended && !selected && (
            <span className="cl-badge-accent">
              Recommended
            </span>
          )}
          {note && !selected && (
            <span
              data-testid={`${testId}-note`}
              className="rounded-full border border-line px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted"
            >
              {note}
            </span>
          )}
        </span>
        <span className="text-[11px] leading-snug text-secondary">{blurb}</span>
      </span>
    </button>
  )
}
