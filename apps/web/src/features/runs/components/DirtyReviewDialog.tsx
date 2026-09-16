import { useEffect, useState } from 'react'
import type { DirtySpecSummary, Feature, RunDetail, RunIndexEntry } from '@/shared/api/types'
import * as api from '@/shared/api/client'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { shortRunRef } from '@/shared/lib/format'
import { suiteRelativeFile } from '@/shared/lib/test-versions'
import { Modal } from '@/shared/ui/atoms'
import { EmptyGlyph, EmptyState } from '@/shared/ui/EmptyState'
import { EMPTY_COPY } from '@/shared/ui/empty-state-copy'
import { useRun } from '../state/RunsContext'
import { WEAKER_HINT_COPY, featureTone, pendingFileScope, specTone } from '../utils/spec-integrity'
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
export function DirtyReviewDialog({ features, pendingRuns = [], focusFeature, focusRunId, focusRunDetail, focus, onFocus, onChooseFeature, onFeaturesChanged, onClose }: Props) {
  const [runFiles, setRunFiles] = useState<{ feature: string; runId: string; files: string[]; error?: string } | null>(null)
  const pendingByFeature = new Map<string, RunIndexEntry>()
  for (const run of pendingRuns) {
    if (!pendingByFeature.has(run.feature) || run.runId === focusRunId) pendingByFeature.set(run.feature, run)
  }
  const dirty = features.filter((feature) => feature.dirty?.status === 'dirty')
  // Navigation stays in place when selection changes the available run or hint.
  const cards: ReviewSuite[] = [
    ...dirty.map((feature) => ({ name: feature.name, feature, run: pendingByFeature.get(feature.name) })),
    ...[...pendingByFeature.values()].filter((run) => !dirty.some((feature) => feature.name === run.feature))
      .map((run) => ({ name: run.feature, feature: null, run })),
  ].sort((a, b) => a.name.localeCompare(b.name))
  // A source can be committed and still differ from a historical run. A
  // run comparison must not depend on there being uncommitted Git changes.
  if (focusFeature && focus?.baseline === 'run' && !cards.some((card) => card.name === focusFeature)) {
    cards.push({ name: focusFeature, feature: features.find((item) => item.name === focusFeature) ?? null, run: undefined })
  }
  const [picked, setPicked] = useState<{ feature: string; file?: string } | null>(focusFeature ? { feature: focusFeature, file: focus?.file } : null)
  const selected = cards.find((card) => card.name === picked?.feature) ?? cards[0]
  const { detail: loadedDetail, error: runError } = useRun(selected?.run?.runId ?? null)
  const detail = loadedDetail ?? focusRunDetail
  const linkedFeature = focusFeature ?? pendingRuns.find((run) => run.runId === focusRunId)?.feature
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
  const spec = specs.find((item) => selected.name === picked?.feature && item.file === picked.file) ?? specs[0]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hintOpen, setHintOpen] = useState(false)
  const [saved, setSaved] = useState<{ name: string; files: number } | null>(null)
  const testChanges = useInvalidationKey('tests')
  useEffect(() => { setSaved(null) }, [testChanges])
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
    setSaved(null)
    onFocus?.({ file, mode: focus?.mode, ...(againstRun ? { baseline: 'run' } : {}) })
  }
  const weaker = specs.some((item) => specTone(item) === 'weaker')
  const tone = spec ? specTone(spec) : selected?.feature ? featureTone(selected.feature) : null
  const run = selected?.run
  const comparisonRunId = againstRun && selected?.name === focusFeature && focusRunId ? focusRunId
    : run?.runId ?? (focusRunDetail?.manifest.feature === selected?.name ? focusRunId ?? undefined : undefined)
  const useRunBaseline = !!comparisonRunId && (againstRun || !selected?.feature)
  const commitFileCount = selected?.feature?.dirty?.specs.length ?? 0
  const activeRun = run && (!useRunBaseline || run.runId === comparisonRunId) && ['running', 'healing'].includes(run.status) && (run.pendingSpecEdits ?? 0) > 0 ? run : undefined
  const reviewKey = JSON.stringify([selected?.name, spec?.file])
  const comparisonFeature = selected?.name
  const comparisonManifest = focusRunDetail?.manifest.runId === comparisonRunId ? focusRunDetail?.manifest
    : detail?.manifest.runId === comparisonRunId ? detail?.manifest : undefined
  const comparisonDir = comparisonManifest?.featureDir
  const snapshotDir = comparisonManifest?.suiteSnapshot?.kind === 'taken' ? comparisonManifest.suiteSnapshot.dir : undefined
  useEffect(() => {
    if (!useRunBaseline || !comparisonFeature || !comparisonRunId) return
    let cancelled = false
    Promise.all([api.getFeatureTests(comparisonFeature), api.getFeatureTests(comparisonFeature, undefined, comparisonRunId)]).then(([current, recorded]) => {
      if (cancelled) return
      const files = [...new Set([...current, ...recorded].map((item) => suiteRelativeFile(item.file, comparisonDir, snapshotDir)))].filter((file) => !file.startsWith('/'))
      setRunFiles({ feature: comparisonFeature, runId: comparisonRunId, files })
    }).catch(() => {
      if (!cancelled) setRunFiles({ feature: comparisonFeature, runId: comparisonRunId, files: [], error: 'Could not list all comparison files. Showing the available files.' })
    })
    return () => { cancelled = true }
  }, [useRunBaseline, comparisonFeature, comparisonRunId, comparisonDir, snapshotDir, testChanges])

  const keepChanges = async (): Promise<void> => {
    if (!selected) return
    const result = await api.commitDirtySpecs(selected.name)
    onFeaturesChanged?.()
    if (!result.committed && result.status !== 'clean') throw new Error(result.reason ?? 'No spec changes were committed.')
    if (result.committed) setSaved({ name: selected.name, files: commitFileCount || specs.length })
    if (!activeRun) return
    // Git and the run snapshot are separate boundaries. A successful commit
    // must not dismiss this review before the run accepts the changed tests.
    try {
      const adopted = await api.adoptSpecEdits(activeRun.runId)
      if (adopted.rerun === 'not-waiting-for-signal') {
        setError('Saved in Git and accepted for this run, but no rerun started. Start a new run to validate these tests.')
        return
      }
    } catch (err) {
      throw new Error(`Saved in Git, but the run could not accept the changes. ${err instanceof Error ? err.message : 'Try again.'}`)
    }
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
        headerActions={<button className="cl-review-hint-link" onClick={() => setHintOpen(true)} title="Read about this advisory check and its limitations">
          {weaker ? 'Possible weakening · about this check' : 'About this check'}
        </button>}
        footer={<div className="cl-review-footer" data-testid="dirty-review-actions">
          <div className="cl-review-commit-context">
            {activeRun ? <p data-testid={`dirty-review-pending-${selected?.name}`}><strong className="text-primary">Keep these test changes?</strong> Yes saves all changed tests in this suite to Git and reruns them. No restores the tests recorded for run {shortRunRef(activeRun.runId)}.</p>
              : saved ? <p role="status">Saved in Git · {saved.files} {saved.files === 1 ? 'file' : 'files'} in {saved.name}. Run again when ready to validate these tests.</p> : useRunBaseline && comparisonRunId !== run?.runId ? <p>Run {shortRunRef(comparisonRunId!)} · Results belong to the recorded tests.</p> : run ? <p data-testid={`dirty-review-pending-${selected?.name}`}>Run {shortRunRef(run.runId)} · {(run.pendingSpecEdits ?? 0) > 0 && <>{run.pendingSpecEdits} {run.pendingSpecEdits === 1 ? 'edit' : 'edits'} not executed. </>}Results belong to the recorded tests.</p> : selected ? <p><strong className="text-primary">{selected.name}</strong> · Save {commitFileCount} {commitFileCount === 1 ? 'file' : 'files'} in Git. Run again to validate.</p> : null}
          </div>
          <div className="cl-review-commit-buttons">
            {activeRun ? <>
              <button className="cl-button px-3 py-1.5 text-xs" disabled={busy} onClick={() => { void act(async () => {
                await api.restoreSpecEdits(activeRun.runId)
                onFeaturesChanged?.()
                onClose()
              }) }}>No, restore tests</button>
              <button className="cl-button-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => { void act(keepChanges) }}>Yes, commit &amp; rerun</button>
            </> : selected?.feature && <button className="cl-button-primary px-3 py-1.5 text-xs" disabled={busy || commitFileCount === 0} title={`Commit all ${commitFileCount} changed test files in ${selected.name}, including files not opened here`} onClick={() => { void act(keepChanges) }}>Commit suite · {commitFileCount} {commitFileCount === 1 ? 'file' : 'files'}</button>}
          </div>
          {error && <p role="alert" className="cl-review-action-message text-danger">{error}</p>}
        </div>}
      >
        {cards.length === 0 ? <div className="p-5"><EmptyState {...EMPTY_COPY.dirtyNoTestFiles} icon={EmptyGlyph.journal} testId="dirty-review-empty" /></div> : <div className="cl-dialog-panes cl-review-panes min-h-0 flex-1">
          <nav className="cl-dialog-rail overflow-auto p-2 scrollbar-thin" aria-label="Changed test files">
            {useRunBaseline && runFiles?.feature === selected.name && runFiles.runId === comparisonRunId && runFiles.error && <p role="status" className="mb-2 px-2 text-xs text-warning">{runFiles.error}</p>}
            <p className="mb-3 px-2 text-[10px] uppercase tracking-wider text-secondary">Suites · {cards.length}</p>
            {cards.map((card) => {
              const files = filesFor(card)
              const assessedFiles = specsFor(card, card === selected ? detail : focusRunDetail)
              return <div key={card.name} className="mb-3" data-testid={`dirty-review-suite-${card.name}`}>
                <p className="mb-1 break-words px-2 text-xs font-medium">{card.name}</p>
                {files.length ? files.map((file) => <button key={file.file} type="button" disabled={busy} aria-pressed={card.name === selected.name && file.file === spec?.file} className="cl-review-file" title={file.file} onClick={() => choose(card.name, file.file)}>
                  <span className="block truncate font-mono text-[11px]">{file.file.replace(/^e2e\//, '')}</span>
                  {assessedFiles.some((item) => item.file === file.file) && <span className="mt-1 flex flex-wrap items-center gap-2"><SpecToneChip tone={specTone(file)} /><span className="text-[10px] text-secondary">{pendingFileScope(file)}</span></span>}
                </button>) : <p className="px-2 text-xs text-secondary">No test files available</p>}
              </div>
            })}
          </nav>
          <section className="cl-review-content" data-testid={`dirty-review-card-${selected.name}`} data-pending={run ? 'true' : undefined} data-tone={tone ?? undefined}>
            {spec ? <FullTestReview key={`${reviewKey}:${useRunBaseline}`} feature={selected.name} file={spec.file} runId={useRunBaseline ? comparisonRunId : undefined} focus={focus} onFocus={onFocus} revision={JSON.stringify(spec)} baselineControl={<label className="cl-review-baseline">
              <span>Compare current source with</span>
              <select aria-label="Compare current source with" className="cl-input px-2 py-1 text-xs" value={useRunBaseline ? 'run' : 'head'} onChange={(event) => {
                const next = event.target.value === 'run'
                setAgainstRun(next)
                onFocus?.({ ...focus, file: spec.file, baseline: next ? 'run' : undefined })
              }}>
                <option value="head" disabled={!selected.feature}>Committed tests · Git HEAD</option>
                <option value="run" disabled={!comparisonRunId}>{comparisonRunId ? `Recorded tests · run ${shortRunRef(comparisonRunId)}` : 'Recorded tests · no run selected'}</option>
              </select>
            </label>} /> : <p role={runError ? 'alert' : 'status'} className="p-4 text-sm">{runError ?? 'No test file selected. Close this dialog and open a comparison from the Tests panel.'}</p>}
          </section>
        </div>}
      </Modal>
      <Modal open={hintOpen} portal onClose={() => setHintOpen(false)} title="A hint, not a verdict" width={500}>
        <p className="px-5 py-4 text-xs leading-relaxed text-secondary" data-testid="dirty-review-hint-copy">{WEAKER_HINT_COPY}</p>
      </Modal>
    </>
  )
}
