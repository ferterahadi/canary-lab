import { useEffect, useRef, useState } from 'react'
import type { DirtySpecStrength, DirtySpecSummary, Feature, RunDetail, RunIndexEntry } from '@/shared/api/types'
import type { PredicateChange, TestChange } from '@shared/verification-strength/types'
import * as api from '@/shared/api/client'
import { shortRunRef } from '@/shared/lib/format'
import { SlideOverPanel } from '@/shared/ui/atoms'
import { EmptyGlyph, EmptyState } from '@/shared/ui/EmptyState'
import { Chip } from '@/shared/ui/StatusChip'
import { SPEC_TONE, WEAKER_HINT_COPY, featureTone, specTone, type SpecEditTone } from '../utils/spec-integrity'

interface Props {
  features: Feature[]
  focusRunId?: string | null
  focusRunDetail?: RunDetail | null
  /** Active runs holding spec edits they have not executed (D9). A suite with
   *  one sorts first and gains the two run-scoped levers, adopt and restore. */
  pendingRuns?: RunIndexEntry[]
  onClose: () => void
}

// Review panel for changed test files. One card per suite whose specs differ
// from the baseline they are compared against — the run-start copy while a run
// is live, else the last green / committed content. Each card names the
// predicate that changed (was → now), the requirement it belonged to, and the
// differential's reading of it; the reading is a hint (D13), never a gate: a
// `weaker` row gets danger tone, the word "hint" and its measured false-positive
// rate, everything else reads as neutral "changed". The verdict of a live run
// already rests on the copy it executed, so nothing here blocks anything — the
// levers are what a human does about the live files: commit them (durable, on
// the git record), adopt them into the run (re-snapshot + rerun), or restore the
// copy's content over them. Chrome mirrors RunsListDialog so the panels read as
// a family. Suites with a pending edit against a live run sort first, then the
// weaker readings — worst first, like every list of work.
export function DirtyReviewDialog({ features, pendingRuns = [], focusRunId, focusRunDetail, onClose }: Props) {
  const pendingByFeature = new Map<string, RunIndexEntry>()
  for (const run of pendingRuns) {
    if (!pendingByFeature.has(run.feature) || run.runId === focusRunId) pendingByFeature.set(run.feature, run)
  }
  const dirty = features.filter((f) => f.dirty?.status === 'dirty')
  // A run whose suite the feature list does not (yet) flag still earns a card —
  // the run knows what it never executed even before the dirty store recomputes.
  const runOnly = [...pendingByFeature.values()].filter((r) => !dirty.some((f) => f.name === r.feature))
  const cards: Array<{ name: string; feature: Feature | null; run: RunIndexEntry | undefined }> = [
    ...dirty.map((f) => ({ name: f.name, feature: f, run: pendingByFeature.get(f.name) })),
    ...runOnly.map((r) => ({ name: r.feature, feature: null, run: r })),
  ].sort((a, b) => (focusRunId ? Number(b.run?.runId === focusRunId) - Number(a.run?.runId === focusRunId) : 0) || cardRank(a) - cardRank(b) || a.name.localeCompare(b.name))

  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<Record<string, string | undefined>>({})
  const [workspaceOpenError, setWorkspaceOpenError] = useState<string | null>(null)

  // The list is fed by live feature + run data — once a suite clears it drops
  // out on its own. Close when the LAST card leaves so the panel doesn't linger
  // empty after a commit/adopt/restore — but only on that transition. Mounting
  // with no cards is a different situation: a cold ?dialog=tests-review load
  // arrives before the feature list does, and closing then dropped the route
  // param before the data could ever fill the panel (seen live). An empty
  // mount shows its empty state instead and waits.
  const hadCards = useRef(false)
  useEffect(() => {
    if (cards.length > 0) hadCards.current = true
    else if (hadCards.current) onClose()
  }, [cards.length, onClose])

  // One global action for the whole panel — opens the workspace repo (not any
  // one file) in the project's configured editor, since every changed spec here
  // lives in the same workspace.
  const openWorkspace = async (): Promise<void> => {
    setWorkspaceOpenError(null)
    try {
      const res = await api.openWorkspace()
      if (!res.opened) setWorkspaceOpenError(res.error ?? 'Failed to open editor')
    } catch (err) {
      setWorkspaceOpenError(err instanceof Error ? err.message : 'Failed to open editor')
    }
  }

  // The three levers share one busy/error slot per suite: they are alternatives,
  // and the WS-driven refetch (tests-dirty-changed / the run's update frame)
  // drops the card once the live files and the record agree — no local state to
  // clear on success.
  const act = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy((b) => ({ ...b, [name]: true }))
    setError((e) => ({ ...e, [name]: undefined }))
    try {
      await action()
    } catch (err) {
      setError((e) => ({ ...e, [name]: err instanceof Error ? err.message : 'action failed' }))
    } finally {
      setBusy((b) => ({ ...b, [name]: false }))
    }
  }

  const anyWeaker = cards.some((c) => (c.feature ? featureTone(c.feature) : null) === 'weaker')
    || (focusRunDetail?.manifest.specEdits?.pending ?? []).some((spec) => specTone(spec) === 'weaker')

  return (
    <SlideOverPanel
      onClose={onClose}
      ariaLabel="Changed test files"
      testId="dirty-review-dialog"
      header={
        <>
          <h2 className="min-w-0 flex-1 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Tests changed
          </h2>
          <button
            type="button"
            title="Open workspace in editor"
            aria-label="Open workspace in editor"
            onClick={openWorkspace}
            className="cl-icon-button h-6 w-6 shrink-0 text-[12px]"
          >
            ↗
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs"
            style={{ color: 'var(--text-secondary)' }}
          >
            Close
          </button>
        </>
      }
    >
      <div className="px-4 pt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        Review the changes, then adopt them to rerun with the edited tests, or restore the original tests.
        Committing saves edits in git; it does not adopt them into an active run.
      </div>
      {anyWeaker && (
        <div className="px-4 pt-1 text-[11px]" style={{ color: 'var(--danger)' }} data-testid="dirty-review-hint-copy">
          {WEAKER_HINT_COPY}
        </div>
      )}
      {workspaceOpenError && (
        <div className="px-4 pt-1 text-[11px]" style={{ color: 'var(--danger)' }}>{workspaceOpenError}</div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-3 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
        {cards.length === 0 && (
          <EmptyState
            icon={EmptyGlyph.journal}
            title="No changed test files"
            body="Every suite matches the specs it is compared against, and no live run is holding an edit it has not executed."
            testId="dirty-review-empty"
          />
        )}
        <ul className="flex flex-col gap-3">
          {cards.map(({ name, feature, run }) => {
            const specs = run && focusRunDetail?.manifest.runId === run.runId
              ? focusRunDetail.manifest.specEdits?.pending ?? feature?.dirty?.specs ?? []
              : feature?.dirty?.specs ?? []
            const tone = feature ? featureTone(feature) : null
            const isBusy = busy[name] ?? false
            const danger = tone === 'weaker'
            return (
              <li
                key={name}
                data-testid={`dirty-review-card-${name}`}
                data-pending={run ? 'true' : undefined}
                data-tone={tone ?? undefined}
                className="rounded-lg border p-3"
                style={{
                  borderColor: danger ? 'color-mix(in srgb, var(--danger) 35%, transparent)' : 'var(--border-default)',
                  background: danger ? 'color-mix(in srgb, var(--danger) 8%, transparent)' : 'transparent',
                }}
              >
                <div className="mb-1 flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {name}
                  </span>
                  {tone && <ToneChip tone={tone} />}
                </div>
                {run && (
                  <div className="mb-2 text-[11px]" style={{ color: 'var(--text-secondary)' }} data-testid={`dirty-review-pending-${name}`}>
                    Pending against run <span style={{ fontFamily: 'var(--font-mono)' }}>{shortRunRef(run.runId)}</span>
                    {' · '}
                    {plural(run.pendingSpecEdits ?? 0, 'edit')} not executed — the verdict is from the run-start snapshot
                  </div>
                )}
                {specs.length > 0 && (
                  <ul className="mb-2 flex flex-col gap-2">
                    {specs.map((spec) => <SpecRows key={spec.file} spec={spec} />)}
                  </ul>
                )}
                {error[name] && (
                  <div className="mb-2 text-[11px]" style={{ color: 'var(--danger)' }}>{error[name]}</div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {run && (
                    <>
                      <button
                        type="button"
                        onClick={() => act(name, () => api.restoreSpecEdits(run.runId))}
                        disabled={isBusy}
                        className="cl-button px-2.5 py-1 text-xs"
                        title="Put the live spec files back to what this run executed"
                      >
                        Restore original tests
                      </button>
                      <button
                        type="button"
                        onClick={() => act(name, () => api.adoptSpecEdits(run.runId))}
                        disabled={isBusy}
                        className="cl-button-primary px-2.5 py-1 text-xs"
                        title="Take the edited suite as this run's suite and rerun it"
                      >
                        Adopt &amp; rerun
                      </button>
                    </>
                  )}
                  {feature && (
                    <button
                      type="button"
                      onClick={() => act(name, () => api.commitDirtySpecs(name))}
                      disabled={isBusy}
                      className="cl-button px-2.5 py-1 text-xs"
                      title="Stage and commit exactly these spec files"
                    >
                      {isBusy ? 'Working…' : 'Commit changes'}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </SlideOverPanel>
  )
}

/** Worst first: a suite with an edit a live run never executed outranks one
 *  that merely changed, and a weaker reading outranks the rest within each. */
function cardRank(card: { feature: Feature | null; run: RunIndexEntry | undefined }): number {
  const tone = card.feature ? featureTone(card.feature) : null
  return (card.run ? 0 : 10) + (tone === 'weaker' ? 0 : tone === 'stronger' ? 2 : 1)
}

function ToneChip({ tone }: { tone: SpecEditTone }) {
  const t = SPEC_TONE[tone]
  return (
    <Chip
      chrome="border"
      tone={t.color}
      icon={<span aria-hidden="true">{t.glyph}</span>}
      label={tone === 'weaker' ? `${t.label} · hint` : t.label}
      title={t.title}
      testId={`dirty-review-tone-${tone}`}
    />
  )
}

/** One changed spec: its path, then each changed test with its requirement
 *  tags and predicate rows. Without a readable verdict (a hash-only record) the
 *  old file-plus-test-names listing is what there is to show. */
function SpecRows({ spec }: { spec: DirtySpecSummary }) {
  const tone = specTone(spec)
  return (
    <li>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 truncate text-[11px]"
          style={{ fontFamily: 'var(--font-mono)', color: tone === 'weaker' ? 'var(--danger)' : 'var(--text-secondary)' }}
          title={spec.file}
        >
          {spec.file}
        </span>
        <span className="cl-count-chip shrink-0">{spec.affectedTests.length}</span>
        {spec.strength && (
          <span className="cl-rubric shrink-0" title="Which content the edit is compared against">
            vs {spec.strength.baseline === 'run-start' ? 'run start' : 'committed'}
          </span>
        )}
      </div>
      {spec.strength ? (
        <StrengthRows strength={spec.strength} />
      ) : (
        spec.affectedTests.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1 pl-3" style={{ borderLeft: '1px solid var(--border-default)' }}>
            {spec.affectedTests.map((t) => (
              <li key={t} className="truncate text-[11px]" style={{ color: 'var(--text-secondary)' }} title={t}>
                {t}
              </li>
            ))}
          </ul>
        )
      )}
    </li>
  )
}

function StrengthRows({ strength }: { strength: DirtySpecStrength }) {
  return (
    <ul className="mt-1 flex flex-col gap-1.5 pl-3" style={{ borderLeft: '1px solid var(--border-default)' }}>
      {(strength.reasons ?? []).map((reason) => (
        <li key={reason} className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Cannot classify: {reason}
        </li>
      ))}
      {strength.tests.map((test) => <TestRow key={`${test.kind}:${test.name}`} test={test} />)}
    </ul>
  )
}

function TestRow({ test }: { test: TestChange & { requirements?: string[] } }) {
  const tone = SPEC_TONE[test.verdict === 'weaker' ? 'weaker' : test.verdict === 'stronger' ? 'stronger' : 'changed']
  return (
    <li className="min-w-0" data-testid="dirty-review-test">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
        <span aria-hidden="true" className="shrink-0 font-semibold" style={{ color: tone.color }}>{tone.glyph}</span>
        <span className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }} title={test.name}>
          {test.kind === 'renamed' && test.wasNamed ? `${test.wasNamed} → ${test.name}` : test.name}
        </span>
        <span className="cl-rubric shrink-0">{TEST_KIND_LABEL[test.kind]}</span>
        {(test.requirements ?? []).map((id) => (
          <span
            key={id}
            className="shrink-0 rounded px-1 text-[10px]"
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', background: 'var(--bg-selected)' }}
            title="Requirement this test enforces"
          >
            @{id}
          </span>
        ))}
      </div>
      {test.reason && (
        <div className="pl-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>{test.reason}</div>
      )}
      {test.changes.length > 0 && (
        <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
          {test.changes.map((change, i) => <ChangeRow key={i} change={change} />)}
        </ul>
      )}
    </li>
  )
}

const TEST_KIND_LABEL: Record<TestChange['kind'], string> = {
  changed: 'changed',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  disabled: 'disabled — enforces nothing',
  enabled: 'enabled',
}

/** One predicate: what it asserted before the edit and what it asserts now.
 *  Source as written (`TestPredicate.source`), mono, so the reader sees the
 *  assertion and not the differential's model of it. A side that is not there
 *  (a removed or added predicate) prints as an em dash. */
function ChangeRow({ change }: { change: PredicateChange }) {
  const color = change.verdict === 'weaker' ? 'var(--danger)' : change.verdict === 'stronger' ? 'var(--success)' : 'var(--text-muted)'
  return (
    <li className="grid gap-x-2 text-[10.5px]" style={{ gridTemplateColumns: 'max-content minmax(0, 1fr)' }} data-testid="dirty-review-change">
      <span className="cl-rubric self-start pt-px" style={{ color }} title={change.reason}>{change.kind}</span>
      <span className="min-w-0">
        <span className="block truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }} title={change.before?.source}>
          was {change.before?.source ?? '—'}
        </span>
        <span className="block truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }} title={change.after?.source}>
          now {change.after?.source ?? '—'}
        </span>
        {change.verdict === 'unclassifiable' && change.reason && (
          <span className="block" style={{ color: 'var(--text-muted)' }}>cannot classify: {change.reason}</span>
        )}
      </span>
    </li>
  )
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
