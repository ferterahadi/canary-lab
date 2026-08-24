import { useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { FeatureDocsListing, FlightManifest, PrdSourceAttempt, PrdSourceCheckpointData } from '@/shared/api/client'
import { AddDocsTile, DocPill, DocsDropOverlay, EmptyDropzone, useDocDrop } from '@/features/coverage/components/CoverageDocsRail'
import { STAGE_COLUMN } from './stage-meta'
import { DisabledControlTooltip } from '@/shared/ui/Tooltip'
import { ForkPathCard, IntentRow, useFlightDocs } from './FlightDocsPanel'
import { externalMutationTooltip, isExternallyDriven } from '../lib/external-work'

/** Read the structured outcome of the previous collector attempt off the
 *  parked checkpoint. Absent on a first visit, and on flights parked by an
 *  older server (which folded the reason into `message` instead) — both cases
 *  simply fall back to the neutral first-visit rendering. */
export function prdSourceAttempt(flight: FlightManifest): PrdSourceAttempt | null {
  const stage = flight.stages.find((s) => s.key === 'docs')
  const data = stage?.checkpoint?.data as PrdSourceCheckpointData | undefined
  return data?.lastAttempt ?? null
}

/** Headline for the verdict band — states what the agent DID, so the row reads
 *  as a finding rather than as an error the user caused. */
export function attemptHeadline(attempt: PrdSourceAttempt): string {
  if (attempt.outcome === 'no-diff') return 'Nothing changed vs. the base branch — nothing to work from'
  if (attempt.outcome === 'no-output') return 'Agent ran · produced no document'
  return attempt.mode === 'infer-from-diff'
    ? 'Agent read the diff · found nothing'
    : 'Agent searched the repos · found nothing'
}

/** The empty-handed verdict, given its own row above the fork. Amber + a
 *  left-edge rule matches how the console marks "needs your attention"
 *  elsewhere, without the weight of a full tinted card. */
export function AttemptVerdict({ attempt }: { attempt: PrdSourceAttempt }) {
  return (
    <div
      data-testid="prd-source-verdict"
      className="flex items-start gap-2 border-l-2 border-warning bg-warning/7 px-2.5 py-2"
    >
      <span aria-hidden="true" className="mt-px text-[11px] text-warning">⊘</span>
      <div className="flex min-w-0 flex-col gap-1">
        <span
          className="cl-rubric text-warning"
        >
          {attemptHeadline(attempt)}
        </span>
        {attempt.reason && (
          <span className="text-[12px] leading-snug text-primary">{attempt.reason}</span>
        )}
      </div>
    </div>
  )
}

/** The prd-source checkpoint as a two-path fork (R74). Owns the whole
 *  Requirements surface while the flight is parked: choose a path, then the
 *  path's state — manual drop zone (no agent) or the two agent hints. Every
 *  release goes through the same respond_flight_checkpoint the MCP path uses. */
export function RequirementsFork({
  flightId,
  flight,
  refreshKey,
  onResponded,
  listing,
}: {
  flightId: string
  flight: FlightManifest
  /** Bumped on coverage-changed so out-of-band doc writes show live. */
  refreshKey?: number
  onResponded: () => void
  /** The listing the stage band already fetched — see useFlightDocs. */
  listing?: FeatureDocsListing | null
}) {
  const [mode, setMode] = useState<'manual' | 'agent' | null>(null)
  /** Agent hint is *staged*, not fired — picking a card must never spawn the
   *  agent. The release goes through the confirm button, same as manual. */
  const [hint, setHint] = useState<'collect-repo-docs' | 'infer-from-diff' | null>(null)
  /** Outcome of the collector's last run, when this park follows a failed one.
   *  Drives both the verdict band and which path we recommend. */
  const lastAttempt = prdSourceAttempt(flight)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** A quick "Agent started" flash beside the button — appears on press and
   *  fades on its own (cl-flash-fade). The token forces a remount so a repeat
   *  press restarts the animation even if the previous flash hasn't finished. */
  const [startedFlash, setStartedFlash] = useState<number | null>(null)
  const docs = useFlightDocs(flight.feature, refreshKey, undefined, listing)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // The fork is an answering surface end to end — every path ends in a
  // respond_flight_checkpoint. When the MCP client that started the flight is
  // driving, that answer is its call, so the two path cards render inert: the
  // reader still sees WHICH question the flight stopped on and what the last
  // collector attempt found, but cannot pick for the agent. Disabling the cards
  // is enough to close the whole surface — `mode` can never leave null, so no
  // path content (drop zone, agent hints, confirm buttons) ever mounts.
  const readOnly = isExternallyDriven(flight)
  const lockedTitle = readOnly
    ? externalMutationTooltip('flight', 'choose the requirements source')
    : undefined
  const disabled = busy || docs.busy || readOnly
  const { dragging, dropHandlers } = useDocDrop(disabled || mode !== 'manual', (files) => { void docs.importFiles(files) })

  const respond = (choice: string): void => {
    setBusy(true)
    setFailure(null)
    api.respondFlightCheckpoint(flightId, { choice })
      .then(() => onResponded())
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <section
      data-testid="requirements-fork"
      className={`relative flex flex-col gap-2.5 rounded-lg border p-3 border-line bg-surface ${STAGE_COLUMN}`}
      {...dropHandlers}
    >
      {lastAttempt && <AttemptVerdict attempt={lastAttempt} />}
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-[11px] text-warning">⏸</span>
        <span className="text-[12.5px] font-semibold">Where should requirements come from?</span>
      </div>
      <IntentRow description={flight.description} />
      <input
        ref={fileInputRef}
        data-testid="flight-doc-file-input"
        type="file"
        multiple
        accept=".md,.markdown,.txt,.pdf,.docx"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) void docs.importFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {/* Both path cards stay on screen — picking one lights it and unfolds
          its content below; the other recedes but never hides, so the current
          choice is always visible and reversible in one click. */}
      <div role="radiogroup" aria-label="Requirements source" className="flex flex-wrap gap-2.5">
        {/* The recommendation follows the evidence: once a collector has come
            back empty, pointing the user at the same collector again is the
            wrong default — the material it was asked to find isn't in these
            repos. The agent path stays available (a retry with feedback, or a
            different repo set, is legitimate) but stops being the suggestion. */}
        <ForkPathCard
          testId="fork-path-manual"
          title="I'll add docs myself"
          blurb="Drop in a product brief, spec, or ticket. No agent runs."
          recommended={lastAttempt !== null}
          selected={mode === 'manual'}
          dimmed={mode === 'agent'}
          disabled={disabled}
          disabledTitle={lockedTitle}
          onPick={() => setMode('manual')}
        />
        <ForkPathCard
          testId="fork-path-agent"
          title="Let the agent find them"
          blurb={lastAttempt
            ? 'Retry with feedback, or point it at different repos.'
            : 'An agent goes looking, using what you asked for above.'}
          recommended={lastAttempt === null}
          note={lastAttempt ? (lastAttempt.outcome === 'no-diff' ? 'No diff' : 'Tried · empty') : undefined}
          selected={mode === 'agent'}
          dimmed={mode === 'manual'}
          disabled={disabled}
          disabledTitle={lockedTitle}
          onPick={() => setMode('agent')}
        />
      </div>

      {mode === 'manual' && (
        <>
          {docs.sourceDocs.length === 0 ? (
            <EmptyDropzone
              title="Add requirement docs"
              onPick={() => fileInputRef.current?.click()}
              dragging={dragging}
              busy={disabled}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {docs.sourceDocs.map((d) => (
                <DocPill
                  key={d.relPath}
                  relPath={d.relPath}
                  dirPrefix={`features/${flight.feature}/docs/`}
                  generated={d.generated}
                  sizeBytes={d.sizeBytes}
                  linked={d.linked}
                  linkTarget={d.linkTarget}
                  broken={d.broken}
                  busy={disabled}
                  onOpen={() => docs.openDoc(d.absPath)}
                  onRemove={() => docs.removeDoc(d.relPath)}
                  removeTitle="Remove doc"
                />
              ))}
              <AddDocsTile testId="flight-doc-add-files" onPick={() => fileInputRef.current?.click()} disabled={disabled} />
            </div>
          )}
          <div className="flex justify-end">
            <DisabledControlTooltip>
              <button
                type="button"
                data-testid="fork-use-docs"
                disabled={disabled || docs.sourceDocs.length === 0}
                onClick={() => respond('continue')}
                className="cl-button-primary px-2.5 py-1 text-xs"
                title={lockedTitle ?? (docs.sourceDocs.length === 0 ? 'Add at least one doc first' : 'Approve these docs and turn them into requirements')}
              >
                Use these docs
              </button>
            </DisabledControlTooltip>
          </div>
        </>
      )}

      {mode === 'agent' && (
        <>
          <div className="cl-rubric">
            Where should the agent look?
          </div>
          <div className="flex flex-wrap gap-2.5">
            <ForkPathCard
              testId="fork-hint-collect-repo-docs"
              title="Collect docs from the repos"
              blurb="The agent copies in only the docs relevant to the intent."
              selected={hint === 'collect-repo-docs'}
              dimmed={hint === 'infer-from-diff'}
              disabled={disabled}
              disabledTitle={lockedTitle}
              onPick={() => setHint('collect-repo-docs')}
            />
            <ForkPathCard
              testId="fork-hint-infer-from-diff"
              title="Infer from the git diff"
              blurb="The agent reads what changed on this branch and matches it to what you asked for."
              selected={hint === 'infer-from-diff'}
              dimmed={hint === 'collect-repo-docs'}
              disabled={disabled}
              disabledTitle={lockedTitle}
              onPick={() => setHint('infer-from-diff')}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            {startedFlash !== null && (
              <span
                key={startedFlash}
                data-testid="fork-start-agent-flash"
                className="cl-flash-fade text-[11px] font-medium text-accent"
                onAnimationEnd={() => setStartedFlash(null)}
              >
                Agent started — its output shows under Activity below
              </span>
            )}
            <DisabledControlTooltip>
              <button
                type="button"
                data-testid="fork-start-agent"
                disabled={disabled || hint === null}
                onClick={() => {
                  if (!hint) return
                  respond(hint)
                  setStartedFlash(Date.now())
                }}
                className="cl-button-primary px-2.5 py-1 text-xs"
                title={lockedTitle ?? (hint === null ? 'Pick where it should look first' : 'Start the agent with this approach')}
              >
                {busy ? 'Starting…' : 'Let the agent gather them'}
              </button>
            </DisabledControlTooltip>
          </div>
        </>
      )}

      {(failure ?? docs.error) && (
        <div className="text-[11px] text-danger">{failure ?? docs.error}</div>
      )}
      {dragging && mode === 'manual' && <DocsDropOverlay label="Drop to add requirement docs" />}
    </section>
  )
}
