import { useEffect, useRef, useState } from 'react'
import type { DirtySpecSummary, Feature, RunDetail, RunIndexEntry } from '@/shared/api/types'
import type { FeatureTestReview, RunTestReview } from '@shared/test-review'
import * as api from '@/shared/api/client'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { shortRunRef } from '@/shared/lib/format'
import { TEST_CHANGE_KINDS, type TestChangeKind, type TestVersionChanges, type VersionTest } from '@/shared/lib/test-versions'
import { ChevronLeftIcon, ChevronRightIcon, Modal, StatusDot } from '@/shared/ui/atoms'
import { TEST_CHANGE_MARKS, TestChangeMark } from '@/shared/ui/TestChangeMark'
import { EmptyGlyph, EmptyState } from '@/shared/ui/EmptyState'
import { EMPTY_COPY } from '@/shared/ui/empty-state-copy'
import { useRun } from '../state/RunsContext'
import { featureTone, pendingFileScope, specTone } from '../utils/spec-integrity'
import { SpecToneChip } from './SpecToneChip'
import { FullTestReview, type ReviewFocus } from './FullTestReview'

interface Props {
  features: Feature[]
  focusFeature?: string | null
  focusRunId?: string | null
  focusRunDetail?: RunDetail | null
  pendingRuns?: RunIndexEntry[]
  focus?: ReviewFocus
  onFocus?: (focus: ReviewFocus) => void
  onChooseFeature?: (name: string) => void
  onFeaturesChanged?: () => void
  onClose: () => void
}

interface ReviewSuite {
  name: string
  feature: Feature | null
  run: RunIndexEntry | undefined
}

function specsFor(card: ReviewSuite, detail: RunDetail | null | undefined): DirtySpecSummary[] {
  const files = new Map((card.feature?.dirty?.specs ?? []).map((spec) => [spec.file, spec]))
  if (card.run && detail?.manifest.runId === card.run.runId) {
    for (const spec of detail.manifest.specEdits?.pending ?? []) files.set(spec.file, spec)
  }
  return [...files.values()]
}

/** The selected file and its actions share one owner. Live run snapshots take
 * precedence over feature summaries; reading a hint never adopts an edit. */
export function DirtyReviewDialog({ features, pendingRuns = [], focusFeature, focusRunId, focusRunDetail, focus: routedFocus, onFocus, onChooseFeature, onFeaturesChanged, onClose }: Props) {
  const [focus, setFocus] = useState(routedFocus)
  useEffect(() => { setFocus(routedFocus) }, [routedFocus])
  const updateFocus = (next: ReviewFocus): void => { setFocus(next); onFocus?.(next) }
  const [navigationTarget, setNavigationTarget] = useState<HTMLDivElement | null>(null)
  const [runFiles, setRunFiles] = useState<{ feature: string; runId: string; revision: number; rootsKey: string; files: string[]; changedFiles: string[]; changes?: TestVersionChanges; error?: string } | null>(null)
  const pendingByFeature = new Map<string, RunIndexEntry>()
  for (const run of pendingRuns) {
    if (!pendingByFeature.has(run.feature) || run.runId === focusRunId) pendingByFeature.set(run.feature, run)
  }
  const linkedFeature = focusFeature ?? pendingRuns.find((run) => run.runId === focusRunId)?.feature
  const suiteName = linkedFeature ?? [...new Set([
    ...features.filter((feature) => feature.dirty?.status === 'dirty').map((feature) => feature.name),
    ...pendingByFeature.keys(),
  ])].sort((a, b) => a.localeCompare(b))[0]
  // Keep the entry suite even after its edits are committed; never fall through
  // to another suite when a live refresh removes its dirty state.
  const selected: ReviewSuite | undefined = suiteName ? {
    name: suiteName,
    feature: features.find((feature) => feature.name === suiteName) ?? null,
    run: pendingByFeature.get(suiteName),
  } : undefined
  const [picked, setPicked] = useState<{ feature: string; file?: string } | null>(focusFeature ? { feature: focusFeature, file: focus?.file } : null)
  const { detail: loadedDetail, error: runError } = useRun(selected?.run?.runId ?? null)
  const detail = loadedDetail ?? focusRunDetail
  const linkedSpec: DirtySpecSummary | undefined = focus?.file ? { file: focus.file, affectedTests: [] } : undefined
  // A completed-run comparison can have a linked file without pending edits.
  // The sidebar and comparison must resolve that file from the same list.
  const filesFor = (card: ReviewSuite): DirtySpecSummary[] => {
    const files = specsFor(card, card === selected ? detail : focusRunDetail)
    if (linkedSpec && card.name === linkedFeature && !files.some((file) => file.file === linkedSpec.file)) files.push(linkedSpec)
    if (runFiles?.feature === card.name && runFiles.runId === (card.name === focusFeature && focus?.baseline === 'run' ? focusRunId : card.run?.runId)) {
      for (const file of runFiles.files) if (!files.some((item) => item.file === file)) files.push({ file, affectedTests: [] })
    }
    return files.sort((a, b) => a.file.localeCompare(b.file))
  }
  const specs = selected ? filesFor(selected) : []
  const assessedFiles = selected ? specsFor(selected, detail) : []
  const spec = specs.find((item) => selected?.name === picked?.feature && item.file === picked?.file) ?? specs[0]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const testChanges = useInvalidationKey('tests')
  const [againstRun, setAgainstRun] = useState(focus?.baseline === 'run')
  useEffect(() => { setAgainstRun(focus?.baseline === 'run') }, [focus?.baseline])
  useEffect(() => { setPicked(focusFeature ? { feature: focusFeature, file: focus?.file } : null) }, [focusFeature, focusRunId, focus?.file])

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : 'Action failed') }
    finally { setBusy(false) }
  }
  const choose = (feature: string, file: string): void => {
    setPicked({ feature, file })
    if (feature !== focusFeature) onChooseFeature?.(feature)
    setError(null)
    updateFocus({ file, mode: focus?.mode, ...(againstRun ? { baseline: 'run' } : {}) })
  }
  const tone = spec ? specTone(spec) : selected?.feature ? featureTone(selected.feature) : null
  const run = selected?.run
  // RunStore decisions arrive through the run WebSocket as a new manifest.
  // Use that pushed revision to refetch the REST-only review immediately;
  // bounded reconciliation below remains the missed-event recovery path.
  const reviewRefreshKey = JSON.stringify([
    detail?.manifest.specEdits?.checkedAt,
    detail?.manifest.specEdits?.reviewDecisions,
  ])
  const runReview = useLiveResource<RunTestReview>('tests', run?.runId ?? null, api.getRunTestReview, {
    reconcileMs: 5000,
    leaseMs: 15000,
    refreshKey: reviewRefreshKey,
  })
  const reviewState = runReview.value?.reviewState ?? (runReview.value?.canAdopt && run && ['running', 'healing'].includes(run.status) ? 'pending-active' : undefined)
  const pendingRunReview = reviewState === 'pending-active' || reviewState === 'pending-terminal'
  const comparisonRunId = againstRun && selected && selected.name === focusFeature && focusRunId && (!focusRunDetail || focusRunDetail.manifest.feature === selected.name) ? focusRunId
    : run?.runId ?? (focusRunDetail?.manifest.feature === selected?.name ? focusRunId ?? undefined : undefined)
  // A decision must display the same recorded-run boundary its exact revision
  // will settle. Otherwise a cold pending-review link can show Git changes
  // while Accept & commit targets a different run-scoped file set.
  const useRunBaseline = !!comparisonRunId && (againstRun || !selected?.feature || pendingRunReview)
  const featureReview = useLiveResource<FeatureTestReview>('tests', !run && selected?.feature ? selected.name : null, api.getFeatureTestReview, {
    reconcileMs: 5000,
    leaseMs: 15000,
  })
  const reviewStateMatchesRun = reviewState === 'pending-active'
    ? !!run && ['running', 'healing'].includes(run.status)
    : reviewState === 'pending-terminal'
      ? !!run && ['passed', 'failed', 'aborted'].includes(run.status)
      : false
  const reviewRun = run && reviewStateMatchesRun && (!useRunBaseline || run.runId === comparisonRunId)
    && runReview.value?.files.length
    && (runReview.value.allowedActions ?? (runReview.value.canAdopt ? ['adopt-and-rerun', 'restore'] : []))
      .some((action) => action === 'adopt-and-rerun' || action === 'approve-new-run' || action === 'restore')
    ? run : undefined
  const reviewRevision = reviewRun ? runReview.value?.review_revision : undefined
  const featureReviewRevision = !reviewRun && featureReview.value?.files.length ? featureReview.value.review_revision : undefined
  const displayedRunRevision = useRef<string>()
  const displayedFeatureReview = useRef(false)
  if (reviewRevision) displayedRunRevision.current = reviewRevision
  if (featureReviewRevision) displayedFeatureReview.current = true
  useEffect(() => {
    const revision = displayedRunRevision.current
    if (revision && detail?.manifest.specEdits?.reviewDecisions?.some((decision) => decision.revision === revision && decision.receipt)) onClose()
  }, [detail?.manifest.specEdits?.reviewDecisions, onClose])
  useEffect(() => {
    if (!run && featureReview.confirmed && displayedFeatureReview.current && featureReview.value?.files.length === 0) onClose()
  }, [featureReview.confirmed, featureReview.value?.files.length, onClose, run])
  const reviewKey = JSON.stringify([selected?.name, spec?.file])
  const comparisonFeature = selected?.name
  const comparisonManifest = focusRunDetail?.manifest.runId === comparisonRunId ? focusRunDetail?.manifest
    : detail?.manifest.runId === comparisonRunId ? detail?.manifest : undefined
  const comparisonDir = comparisonManifest?.featureDir
  const snapshotDir = comparisonManifest?.suiteSnapshot?.kind === 'taken' ? comparisonManifest.suiteSnapshot.dir : undefined
  const rootsKey = JSON.stringify([comparisonDir, snapshotDir])
  useEffect(() => {
    if (!comparisonFeature || !comparisonRunId) return
    let cancelled = false
    api.getTestSourceComparison(comparisonFeature, comparisonRunId).then((comparison) => {
      if (cancelled) return
      setRunFiles({ feature: comparisonFeature, runId: comparisonRunId, revision: testChanges, rootsKey,
        files: comparison.files, changedFiles: comparison.differences.map((item) => item.file),
        ...(comparison.state === 'ready' ? { changes: comparison.changes }
          : { error: 'Test change counts are unavailable because source or snapshot information is incomplete.' }),
      })
    }).catch(() => {
      if (!cancelled) setRunFiles({ feature: comparisonFeature, runId: comparisonRunId, revision: testChanges, rootsKey, files: [], changedFiles: [], error: 'Could not list all comparison files. Showing the available files.' })
    })
    return () => { cancelled = true }
  }, [comparisonFeature, comparisonRunId, comparisonDir, snapshotDir, rootsKey, testChanges])
  const currentRunFiles = runFiles && runFiles.feature === selected?.name && runFiles.runId === comparisonRunId && runFiles.revision === testChanges && runFiles.rootsKey === rootsKey ? runFiles : null
  const changedFiles = new Set(useRunBaseline
    ? currentRunFiles?.changedFiles ?? []
    : assessedFiles.map((file) => file.file))
  const changes = useRunBaseline ? currentRunFiles?.changes : undefined
  const category = (focus?.change && changes?.[focus.change].length ? focus.change : undefined) ?? TEST_CHANGE_KINDS.find((kind) => changes?.[kind].some((test) => test.file === spec?.file && test.line === focus?.line && (!focus?.test || test.name === focus.test)))
    ?? TEST_CHANGE_KINDS.find((kind) => changes?.[kind].some((test) => test.file === spec?.file))
    // The strip hides a kind at zero, so falling back to a kind with no tests
    // would show marks with none of them lit. Land on the first kind that has
    // tests; `added` only survives when every kind is empty.
    ?? TEST_CHANGE_KINDS.find((kind) => changes?.[kind].length) ?? 'added'
  const tests = changes?.[category] ?? []
  const changeTotal = changes ? TEST_CHANGE_KINDS.reduce((total, kind) => total + changes[kind].length, 0) : 0
  const changedFileCount = currentRunFiles?.changedFiles.length ?? 0
  const exactIndex = tests.findIndex((test) => test.file === spec?.file && test.line === focus?.line && (!focus?.test || test.name === focus.test))
  const testIndex = exactIndex >= 0 ? exactIndex : tests.findIndex((test) => test.file === spec?.file)
  const selectedTest = tests[testIndex]
  const selectTest = (kind: TestChangeKind, test: VersionTest): void => {
    setPicked({ feature: selected!.name, file: test.file })
    updateFocus({ file: test.file, line: test.line, mode: focus?.mode, baseline: 'run', change: kind, test: test.name })
  }
  const reviewFocus = selectedTest ? { ...focus, file: selectedTest.file, line: selectedTest.line, change: category, test: selectedTest.name } : focus

  const acceptChanges = async (): Promise<void> => {
    if (!selected) return
    if (reviewRun && reviewRevision) await api.acceptRunTestReview(reviewRun.runId, reviewRevision)
    else if (featureReviewRevision) await api.acceptFeatureTestReview(selected.name, featureReviewRevision)
    else return
    onFeaturesChanged?.()
    onClose()
  }

  const restoreChanges = async (): Promise<void> => {
    if (!selected) return
    if (reviewRun && reviewRevision) await api.restoreSpecEdits(reviewRun.runId, { expectedRevision: reviewRevision })
    else if (featureReviewRevision) await api.restoreFeatureTestReview(selected.name, featureReviewRevision)
    else return
    onFeaturesChanged?.()
    onClose()
  }

  return (
    <>
      <Modal
        open
        portal
        onClose={onClose}
        title="Compare test versions"
        ariaLabel="Changed test files"
        testId="dirty-review-dialog"
        width={2560}
        height="96vh"
        viewportInset={2}
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
        footer={<div className="cl-review-footer" data-testid="dirty-review-actions">
          <div className="cl-review-footer-navigation" ref={setNavigationTarget}>
            {useRunBaseline && <div className="cl-review-change-nav" role="group" aria-label="Test changes across this suite" title="One item per test(...) declaration. Imports and setup do not count. Loops count once.">
              {/* The same drift marks the tests header shows, doing the job a
                  category dropdown used to: the counts ARE the filter. A native
                  select rendered an OS menu in a token-styled app and spent two
                  of its three rows on kinds with nothing in them. */}
              {changes && TEST_CHANGE_KINDS.map((kind) => changes[kind].length > 0 && <TestChangeMark key={kind} kind={kind} count={changes[kind].length}
                pressed={kind === category} disabled={busy} onClick={() => selectTest(kind, changes[kind][0])}
                tooltip={`${changes[kind].length} ${TEST_CHANGE_MARKS[kind].label} ${changes[kind].length === 1 ? 'test' : 'tests'} in this suite. ${TEST_CHANGE_MARKS[kind].explanation} Step through them here.`}
                ariaLabel={`Show ${changes[kind].length} ${TEST_CHANGE_MARKS[kind].label} ${changes[kind].length === 1 ? 'test' : 'tests'}`} />)}
              <button className="cl-icon-button" aria-label="Previous test change" disabled={!changes || testIndex <= 0 || busy} onClick={() => selectTest(category, tests[testIndex - 1])}><ChevronLeftIcon /></button>
              <span className="cl-review-change-status" aria-live="polite" title={selectedTest?.name}>{!changes ? currentRunFiles?.error ? 'Unavailable' : 'Loading…' : changeTotal === 0 ? changedFileCount > 0 ? `${changedFileCount} changed ${changedFileCount === 1 ? 'file' : 'files'} · no test declaration changes` : 'No test changes' : selectedTest ? `${testIndex + 1} / ${tests.length}` : `— / ${tests.length}`}</span>
              <button className="cl-icon-button" aria-label="Next test change" disabled={!changes || testIndex >= tests.length - 1 || busy} onClick={() => selectTest(category, tests[testIndex + 1])}><ChevronRightIcon /></button>
            </div>}
          </div>
          <div className="cl-review-commit-buttons">
            {(reviewRevision || featureReviewRevision) && <>
              <button className="cl-button px-3 py-1.5 text-xs" disabled={busy || (reviewRun ? !runReview.confirmed : !featureReview.confirmed)} onClick={() => { void act(restoreChanges) }}>Restore recorded files</button>
              <button className="cl-button-primary px-3 py-1.5 text-xs" disabled={busy || (reviewRun ? !runReview.confirmed : !featureReview.confirmed)} onClick={() => { void act(acceptChanges) }}>Accept &amp; commit</button>
            </>}
          </div>
          {run && runReview.error && <p role="alert" className="cl-review-action-message text-danger">Could not confirm this run’s review state. {runReview.error}</p>}
          {!run && featureReview.error && <p role="alert" className="cl-review-action-message text-danger">Could not confirm this suite’s review state. {featureReview.error}</p>}
          {error && <p role="alert" className="cl-review-action-message text-danger">{error}</p>}
        </div>}
      >
        {!selected ? <div className="p-5"><EmptyState {...EMPTY_COPY.dirtyNoTestFiles} icon={EmptyGlyph.journal} testId="dirty-review-empty" /></div> : <div className="cl-dialog-panes cl-review-panes min-h-0 flex-1">
          <nav className="cl-dialog-rail overflow-auto p-2 scrollbar-thin" aria-label="Changed test files">
            {runFiles?.feature === selected.name && runFiles.runId === comparisonRunId && runFiles.error && <p role="status" className="mb-2 px-2 text-xs text-warning">{runFiles.error}</p>}
            <div key={selected.name} className="mb-3" data-testid={`dirty-review-suite-${selected.name}`}>
                <p className="mb-1 break-words px-2 text-xs font-medium">{selected.name}</p>
                {specs.length ? specs.map((file) => {
                  const changed = changedFiles.has(file.file)
                  const baselineLabel = useRunBaseline ? 'the recorded tests' : 'Git HEAD'
                  return <div key={file.file} className="cl-review-file-row"><button type="button" disabled={busy} aria-pressed={file.file === spec?.file} aria-label={`${file.file}${changed ? `, changed compared with ${baselineLabel}` : ''}`} data-changed={changed || undefined} className="cl-review-file" title={file.file} onClick={() => choose(selected.name, file.file)}>
                  <span className="flex min-w-0 items-center gap-1.5"><span className="inline-flex shrink-0" title={changed ? `Changed compared with ${baselineLabel}` : undefined}><StatusDot state="warning" className={changed ? '' : 'invisible'} /></span><span className="block min-w-0 truncate font-mono text-[11px]">{file.file.replace(/^e2e\//, '')}</span></span>
                  {assessedFiles.some((item) => item.file === file.file) && <span className="mt-1 flex flex-wrap items-center gap-2"><SpecToneChip tone={specTone(file)} /><span className="text-[10px] text-secondary">{pendingFileScope(file)}</span></span>}
                </button><button type="button" className="cl-icon-button cl-review-file-editor" disabled={busy} aria-label={`Edit ${file.file} in editor`} title="Open in editor" onClick={() => { void act(async () => {
                  const review = await api.getTestFileReview(selected.name, file.file, useRunBaseline ? comparisonRunId : undefined)
                  const result = await api.openEditor({ file: review.currentPath, line: file.file === spec?.file ? focus?.line ?? 1 : 1 })
                  if (!result.opened) throw new Error('Could not open the editor. Open this file in your workspace.')
                }) }}>↗</button></div>
                }) : <p className="px-2 text-xs text-secondary">No test files available</p>}
            </div>
          </nav>
          <section className="cl-review-content" data-testid={`dirty-review-card-${selected.name}`} data-pending={run ? 'true' : undefined} data-tone={tone ?? undefined}>
            {spec ? <FullTestReview key={`${reviewKey}:${useRunBaseline}`} feature={selected.name} file={spec.file} runId={useRunBaseline ? comparisonRunId : undefined} focus={reviewFocus} onFocus={updateFocus} selectedTest={selectedTest} comparisonReady={Boolean(changes)} revision={JSON.stringify(spec)} navigationTarget={useRunBaseline ? null : navigationTarget} baselineControl={<label className="cl-review-baseline">
              <span>Compare current test with</span>
              <select aria-label="Compare current test with" className="cl-input px-2 py-1 text-xs" value={useRunBaseline ? 'run' : 'head'} onChange={(event) => {
                const next = event.target.value === 'run'
                setAgainstRun(next)
                updateFocus({ ...focus, file: spec.file, change: undefined, test: undefined, baseline: next ? 'run' : undefined })
              }}>
                <option value="head" disabled={!selected.feature || pendingRunReview}>Git HEAD</option>
                <option value="run" disabled={!comparisonRunId}>{comparisonRunId ? `Run ${shortRunRef(comparisonRunId)}` : 'No run selected'}</option>
              </select>
            </label>} /> : <p role={runError ? 'alert' : 'status'} className="p-4 text-sm">{runError ?? 'No test file selected. Close this dialog and open a comparison from the Tests panel.'}</p>}
          </section>
        </div>}
      </Modal>
    </>
  )
}
