import { useCallback, useEffect, useState } from 'react'
import * as coverageApi from '@/shared/api/coverage'
import * as workspaceApi from '@/shared/api/workspace'
import type { FlightStage, FlightStageStatus } from '@shared/flights/types'
import type { FeatureDocsListing } from '@shared/coverage/feature-docs'
import { readAsBase64 } from '@/features/coverage/components/CoverageDocsRail'
import { DocPill } from '@/features/coverage/components/DocPill'
import { DocTree } from '@/shared/ui/DocTree'
import { useDocRelink } from '@/features/coverage/components/DocRelink'
import { PanelCard } from '@/shared/ui/PanelCard'
import { STAGE_COLUMN, StageStatusChip } from './stage-meta'
import { agentActivityLine } from './StageStatusLines'
import { SkeletonLines, SkeletonRows, type AwaitingState } from '@/shared/ui/Skeleton'
import { DisabledControlTooltip } from '@/shared/ui/Tooltip'

// ─── Requirements (R74): the two-path fork + the resting docs panel ──────────
// While the flight is parked on the prd-source checkpoint the FORK owns the
// surface: "I'll add docs myself" (drop zone, no agent) vs "Let the agent find
// them" (two intent-guided hints — collect docs from the repos / infer from
// the git diff — that spawn the server collector; its output streams in the
// stage's activity band). Outside the checkpoint the panel is a read-only
// lens: pills + the summary chip, locked once approved — changes go through
// Continue → from a step → Requirements.

/** Doc CRUD over a feature's docs/ folder — one loader shared by the fork's
 *  manual path and the resting panel (same REST the coverage rail uses).
 *
 *  `external` hands the hook a listing the CALLER already owns (the stage
 *  band's fetch, which the docs stage always performs for its byte tiles) —
 *  without it, the band and this hook each fetched the same listing on the
 *  same `coverage-changed` event, two identical round trips per event for the
 *  whole docs/prd-summary stage. With an external listing the hook never
 *  fetches: mutations publish `coverage-changed` server-side, so the owner's
 *  refetch delivers the post-mutation listing. */
export function useFlightDocs(feature: string, refreshKey?: number, onChanged?: () => void, external?: FeatureDocsListing | null) {
  const [fetched, setFetched] = useState<FeatureDocsListing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const owned = external === undefined
  const listing = owned ? fetched : external

  const load = useCallback((keepError = false) => {
    if (!owned) return
    coverageApi.listFeatureDocs(feature)
      .then((data) => { setFetched(data); if (!keepError) setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [feature, owned])
  useEffect(() => { load() }, [load, refreshKey])
  const relinkDoc = useDocRelink(feature, () => { load(); onChanged?.() })

  const importFiles = useCallback(async (files: FileList) => {
    setBusy(true)
    setError(null)
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        const base64 = await readAsBase64(file)
        await coverageApi.importFeatureDoc(feature, { filename: file.name, contentType: file.type || undefined, base64 })
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
    coverageApi.deleteFeatureDoc(feature, relPath)
      .then(() => { load(); onChanged?.() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [feature, load, onChanged])

  const openDoc = useCallback((absPath: string) => {
    workspaceApi.openEditor({ file: absPath }).catch(() => {})
  }, [])

  const sourceDocs = (listing?.docs ?? []).filter((d) => !d.generated)
  // The distilled artifact (_prd-summary.md/.json) — the stage's actual OUTPUT,
  // the root the source docs nest under.
  const generatedDocs = (listing?.docs ?? []).filter((d) => d.generated)
  return { sourceDocs, generatedDocs, busy, error, importFiles, removeDoc, openDoc, relinkDoc }
}

/** The resting Requirements panel — a read-only lens on docs/ while the stage
 *  runs or after it settles. No add/remove affordances here: while parked the
 *  fork owns editing; once approved the set is honestly frozen.
 *
 *  One card, shaped like the coverage rail's doc tree: the distilled summary
 *  (the stage's OUTPUT) on top, the source docs that went IN nested under its
 *  caret. Two separate cards stated the same in→out relationship as two
 *  unrelated lists. Until the summary exists its slot carries the live status
 *  line and the sources stay a flat list. */
export function FlightDocsPanel({
  feature,
  approved,
  refreshKey,
  summaryStatus,
  summaryStage,
  requirementCount,
  awaiting,
  listing,
}: {
  feature: string
  /** Stage settled done — requirements approved, the doc set is frozen. */
  approved: boolean
  /** Bumped on coverage-changed so out-of-band doc writes show live. */
  refreshKey?: number
  /** The folded prd-summary stage's status — chips the card. */
  summaryStatus?: FlightStageStatus
  /** The folded prd-summary stage itself. Carries the live agent snapshot, which
   *  is what lets the running copy report progress instead of pointing at a
   *  panel that stays empty while the agent works inside one block. */
  summaryStage?: FlightStage
  /** Live requirement count from the folded prd-summary's evidence. */
  requirementCount?: number
  /** R83: the stage hasn't settled — an empty half renders as its skeleton
   *  rather than as a flat "none" sentence, which reads as a finding. */
  awaiting?: AwaitingState
  /** The listing the stage band already fetched — see useFlightDocs. */
  listing?: FeatureDocsListing | null
}) {
  const docs = useFlightDocs(feature, refreshKey, undefined, listing)
  const liveLine = summaryStage ? agentActivityLine(summaryStage) : null
  const showDistilled = summaryStatus !== undefined && summaryStatus !== 'pending'
  const hasSummary = docs.generatedDocs.length > 0
  const sourcesBusy = awaiting === 'live' || summaryStatus === 'running'
  /* The summary slot before the artifact exists. Rendered from `summaryStatus`
     alone (not from the artifact existing) so the running state reports
     progress — otherwise the slot is blank for the whole distillation, which
     is the longest part of the stage. */
  const summarySlot = hasSummary || !(showDistilled || awaiting) ? null
    : awaiting && summaryStatus !== 'running' && summaryStatus !== 'failed'
      ? <SkeletonLines awaiting={awaiting} rows={2} />
      : (
        <div data-testid="docs-summary-status" className="cl-type-meta text-muted">
          {summaryStatus === 'running'
            // The live snapshot when there is one; the fallback makes no
            // promise about where progress shows. No raw answer tail: a slice
            // of half-written JSON reads as a defect, and AgentSessionView
            // below already owns the full output.
            ? (liveLine ?? 'Turning the docs into requirements…')
            : summaryStatus === 'failed'
              ? 'It failed before writing a summary — see Activity below.'
              : 'No summary yet'}
        </div>
      )
  return (
    <section data-testid="flight-docs-panel" className={`flex flex-col gap-3 ${STAGE_COLUMN}`}>
      <PanelCard
        /* The count is the measured total the summary produced, not a count of
           the rows this card lists. */
        kicker={requirementCount != null ? `Requirements found · ${requirementCount}` : 'Requirement docs'}
        aside={(approved || summaryStatus) && (
          <>
            {approved && (
              <span data-testid="docs-locked-chip" className="cl-badge-neutral">
                Locked — approved
              </span>
            )}
            {summaryStatus && (
              <span className="flex items-center gap-1.5 cl-type-meta text-muted" data-testid="docs-summary-chip">
                Summary
                <StageStatusChip status={summaryStatus} />
              </span>
            )}
          </>
        )}
        testId="flight-requirements-card"
      >
        <div className="flex flex-col gap-2">
          {summarySlot}
          {docs.sourceDocs.length === 0 && !hasSummary ? (
            awaiting
              ? <SkeletonRows awaiting={awaiting} rows={2} sub={false} />
              : <div className="cl-type-meta text-muted">No source docs.</div>
          ) : (
            <DocTree
              docs={[...docs.generatedDocs, ...docs.sourceDocs]}
              nest
              /* Open: the sources are half of what this stage shows, not
                 detail to dig for. */
              defaultOpen
              renderPill={(d, disclosure) => (
                <DocPill
                  key={d.relPath}
                  relPath={d.relPath}
                  dirPrefix={`features/${feature}/docs/`}
                  generated={d.generated}
                  sizeBytes={d.sizeBytes}
                  linked={d.linked}
                  linkTarget={d.linkTarget}
                  broken={d.broken}
                  onRelink={d.generated ? undefined : (targetPath) => docs.relinkDoc(d.relPath, targetPath)}
                  busy={!d.generated && sourcesBusy}
                  onOpen={() => docs.openDoc(d.absPath)}
                  removeTitle="Remove doc"
                  disclosure={disclosure}
                />
              )}
            />
          )}
        </div>
        {approved && (
          <p className="mt-2 cl-type-meta text-muted">
            To change these, use Continue → From a step… → Requirements. Everything after that step is redone.
          </p>
        )}
        {docs.error && <div className="mt-2 cl-type-meta text-danger">{docs.error}</div>}
      </PanelCard>
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
      title={open ? 'Hide the full intent' : 'Show the full intent'}
    >
      <span className="cl-rubric shrink-0">
        Intent
      </span>
      {/* Prose, not code — the intent reads in the app face like every other
          sentence on the page (mono stays reserved for paths/commands). */}
      <span
        data-testid="fork-intent-text"
        className={`min-w-0 flex-1 cl-type-body text-secondary ${open ? 'leading-relaxed' : 'truncate'}`}
      >
        {description}
      </span>
      <span className="shrink-0 cl-type-meta text-accent">
        {open ? 'Hide' : 'Show'}
      </span>
    </button>
  )
}

/** One fork path card — a radio-like affordance that STAYS visible after the
 *  pick (R74 polish): the selected card lights sky + shows its dot filled, the
 *  other dims but remains clickable, so the previous choice is never hidden. */
export function ForkPathCard({ testId, title, blurb, recommended, note, selected, dimmed, disabled, disabledTitle, onPick }: {
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
  disabledTitle?: string
  onPick: () => void
}) {
  return (
    <DisabledControlTooltip wrapperClassName="flex min-w-0 flex-1">
      <button
      type="button"
      data-testid={testId}
      role="radio"
      aria-checked={Boolean(selected)}
      disabled={disabled}
      title={disabled ? disabledTitle : undefined}
      onClick={onPick}
      /* Neutral surfaces — the accent lives in the border + radio dot only. */
      className={[
        'relative flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-md border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-45',
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
        <span className="flex items-center gap-1.5 cl-type-title text-primary">
          {title}
          {recommended && !selected && (
            <span className="cl-badge-accent">
              Recommended
            </span>
          )}
          {note && !selected && (
            <span
              data-testid={`${testId}-note`}
              className="cl-badge-neutral"
            >
              {note}
            </span>
          )}
        </span>
        <span className="cl-type-meta leading-snug text-secondary">{blurb}</span>
      </span>
      </button>
    </DisabledControlTooltip>
  )
}
