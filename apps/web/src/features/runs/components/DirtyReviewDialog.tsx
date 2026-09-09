import { useEffect, useState } from 'react'
import type { DirtySpecSummary, Feature, RunDetail, RunIndexEntry } from '@/shared/api/types'
import * as api from '@/shared/api/client'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { shortRunRef } from '@/shared/lib/format'
import { Modal } from '@/shared/ui/atoms'
import { EmptyGlyph, EmptyState } from '@/shared/ui/EmptyState'
import { useRun } from '../state/RunsContext'
import { WEAKER_HINT_COPY, featureTone, specTone } from '../utils/spec-integrity'
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
  onClose: () => void
}

interface ReviewSuite {
  name: string
  feature: Feature | null
  run: RunIndexEntry | undefined
}

function cardRank(card: ReviewSuite): number {
  const tone = card.feature ? featureTone(card.feature) : null
  return (card.run ? 0 : 10) + (tone === 'weaker' ? 0 : tone === 'stronger' ? 2 : 1)
}

function specsFor(card: ReviewSuite, detail: RunDetail | null | undefined): DirtySpecSummary[] {
  return card.run && detail?.manifest.runId === card.run.runId
    ? detail.manifest.specEdits?.pending ?? card.feature?.dirty?.specs ?? []
    : card.feature?.dirty?.specs ?? []
}

/** The selected file and its actions share one owner. Live run snapshots take
 * precedence over feature summaries; reading a hint never adopts an edit. */
export function DirtyReviewDialog({ features, pendingRuns = [], focusFeature, focusRunId, focusRunDetail, focus, onFocus, onChooseFeature, onClose }: Props) {
  const pendingByFeature = new Map<string, RunIndexEntry>()
  for (const run of pendingRuns) {
    if (!pendingByFeature.has(run.feature) || run.runId === focusRunId) pendingByFeature.set(run.feature, run)
  }
  const dirty = features.filter((feature) => feature.dirty?.status === 'dirty')
  const cards: ReviewSuite[] = [
    ...dirty.map((feature) => ({ name: feature.name, feature, run: pendingByFeature.get(feature.name) })),
    ...[...pendingByFeature.values()].filter((run) => !dirty.some((feature) => feature.name === run.feature))
      .map((run) => ({ name: run.feature, feature: null, run })),
  ].sort((a, b) => cardRank(a) - cardRank(b) || a.name.localeCompare(b.name))
  const [picked, setPicked] = useState<{ feature: string; file?: string } | null>(focusFeature ? { feature: focusFeature, file: focus?.file } : null)
  const selected = cards.find((card) => card.name === picked?.feature) ?? cards[0]
  const { detail: loadedDetail, error: runError } = useRun(selected?.run?.runId ?? null)
  const detail = loadedDetail ?? focusRunDetail
  const listedSpecs = selected ? [...specsFor(selected, detail)].sort((a, b) => Number(specTone(b) === 'weaker') - Number(specTone(a) === 'weaker') || a.file.localeCompare(b.file)) : []
  const specs = listedSpecs.length ? listedSpecs : selected && focus?.file ? [{ file: focus.file, affectedTests: [] }] : []
  const spec = specs.find((item) => selected.name === picked?.feature && item.file === picked.file) ?? specs[0]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hintOpen, setHintOpen] = useState(false)
  const [workspaceOpenError, setWorkspaceOpenError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ name: string; files: number } | null>(null)
  const testChanges = useInvalidationKey('tests')
  useEffect(() => { setSaved(null) }, [testChanges])
  const [againstRun, setAgainstRun] = useState(focus?.baseline === 'run')
  useEffect(() => { setPicked(focusFeature ? { feature: focusFeature, file: focus?.file } : null) }, [focusFeature, focusRunId, focus?.file])

  const openWorkspace = async (): Promise<void> => {
    setWorkspaceOpenError(null)
    try {
      const result = await api.openWorkspace()
      if (!result.opened) setWorkspaceOpenError(result.error ?? 'Failed to open editor')
    } catch (err) { setWorkspaceOpenError(err instanceof Error ? err.message : 'Failed to open editor') }
  }
  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : 'Action failed') }
    finally { setBusy(false) }
  }
  const choose = (feature: string, file?: string): void => {
    setPicked({ feature, file })
    if (feature !== focusFeature) onChooseFeature?.(feature)
    setError(null)
    setSaved(null)
    onFocus?.({ file, mode: focus?.mode, ...(againstRun ? { baseline: 'run' } : {}) })
  }
  const weaker = specs.some((item) => specTone(item) === 'weaker')
  const tone = spec ? specTone(spec) : selected?.feature ? featureTone(selected.feature) : null
  const run = selected?.run
  const commitFileCount = selected?.feature?.dirty?.specs.length ?? 0
  const reviewKey = JSON.stringify([selected?.name, spec?.file])

  return (
    <>
      <Modal
        open
        portal
        onClose={onClose}
        title="Tests changed"
        description="Review edits against their baseline."
        ariaLabel="Changed test files"
        testId="dirty-review-dialog"
        width={1440}
        height="88vh"
        viewportInset={6}
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
        headerActions={<button type="button" onClick={() => { void openWorkspace() }} aria-label="Open workspace in editor" title="Open workspace in editor" className="cl-icon-button h-7 w-7 shrink-0">↗</button>}
        subheader={<div className="cl-review-advisory">
          <p className="min-w-0 flex-1">{weaker && <strong className="font-medium text-warning">Possible weakening. </strong>}Assessments are advisory; they do not change the run verdict.</p>
          <button className="shrink-0 text-primary underline decoration-line-strong underline-offset-4" onClick={() => setHintOpen(true)}>About this hint</button>
        </div>}
        footer={<div className="cl-review-footer" data-testid="dirty-review-actions">
          <div className="cl-review-commit-context">
            <p className="truncate text-xs font-medium text-primary" title={selected?.name}>{selected?.name ?? saved?.name}</p>
            {saved ? <p role="status">Saved in Git · {saved.files} {saved.files === 1 ? 'file' : 'files'} in {saved.name}. Run again when ready to validate these tests.</p> : run ? <p data-testid={`dirty-review-pending-${selected?.name}`}>Different from this run · {shortRunRef(run.runId)} · {run.pendingSpecEdits ?? 0} {run.pendingSpecEdits === 1 ? 'edit' : 'edits'} not executed — the verdict is from the run-start snapshot</p> : <p>Commits all changed spec files in this suite. It does not adopt them into an active run.</p>}
          </div>
          <div className="cl-review-commit-buttons">
            {run && ['queued', 'running', 'healing'].includes(run.status) && <>
              <button className="cl-button px-3 py-1.5 text-xs" disabled={busy} onClick={() => { void act(() => api.restoreSpecEdits(run.runId)) }}>Restore original tests</button>
              <button className="cl-button-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => { void act(() => api.adoptSpecEdits(run.runId)) }}>Adopt &amp; rerun</button>
            </>}
            {selected?.feature && <button className="cl-button px-3 py-1.5 text-xs" disabled={busy || commitFileCount === 0} title={`Commit all ${commitFileCount} changed spec files in ${selected.name}, including files not opened here`} onClick={() => { void act(async () => {
              const result = await api.commitDirtySpecs(selected.name)
              if (!result.committed) setError(result.reason ?? 'No spec changes were committed.')
              else setSaved({ name: selected.name, files: commitFileCount })
            }) }}>Commit suite · {commitFileCount} {commitFileCount === 1 ? 'file' : 'files'}</button>}
          </div>
          <div className="cl-review-action-message">{(error || workspaceOpenError) && <p role="alert" className="text-danger">{error || workspaceOpenError}</p>}</div>
        </div>}
      >
        {cards.length === 0 ? <div className="p-5"><EmptyState icon={EmptyGlyph.journal} title="No changed test files" body="No uncommitted test edits remain. Existing run results still describe the tests that run executed." testId="dirty-review-empty" /></div> : <div className="cl-dialog-panes cl-review-panes min-h-0 flex-1">
          <nav className="cl-dialog-rail overflow-auto p-3 scrollbar-thin" aria-label="Changed test files">
            <p className="mb-3 px-2 text-[10px] uppercase tracking-wider text-secondary">Suites · {cards.length}</p>
            {cards.map((card) => {
              const files = specsFor(card, card === selected ? detail : focusRunDetail)
              return <div key={card.name} className="mb-4" data-testid={`dirty-review-suite-${card.name}`}>
                <p className="mb-1 break-words px-2 text-xs font-medium">{card.name}</p>
                {files.length ? files.map((file) => <button key={file.file} type="button" disabled={busy} aria-pressed={card.name === selected.name && file.file === spec?.file} className="cl-review-file" onClick={() => choose(card.name, file.file)}>
                  <span className="block break-words font-mono text-[11px]">{file.file}</span>
                  <span className="mt-2 flex flex-wrap items-center gap-2"><SpecToneChip tone={specTone(file)} /><span className="text-[10px] text-secondary">{file.affectedTests.length} {file.affectedTests.length === 1 ? 'test' : 'tests'}</span></span>
                  {file.strength?.baseline === 'run-start' && <span className="mt-1 block text-[10px] text-secondary">Hint vs run snapshot</span>}
                </button>) : <button className="cl-review-file text-xs" disabled={busy} aria-pressed={card.name === selected.name} onClick={() => choose(card.name)}>Pending test edits</button>}
              </div>
            })}
          </nav>
          <section className="cl-review-content" data-testid={`dirty-review-card-${selected.name}`} data-pending={run ? 'true' : undefined} data-tone={tone ?? undefined}>
            {<div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-xs">
              <button className="cl-button px-2 py-1" aria-pressed={!againstRun && !!selected.feature} disabled={!selected.feature} onClick={() => { setAgainstRun(false); onFocus?.({ ...focus, file: spec?.file, baseline: undefined }) }}>Uncommitted edits</button>
              <button className="cl-button px-2 py-1" aria-pressed={againstRun || !selected.feature} disabled={!run && (!focusRunId || focusRunDetail?.manifest.feature !== selected.name)} onClick={() => { setAgainstRun(true); onFocus?.({ ...focus, file: spec?.file, baseline: 'run' }) }}>Different from this run</button>
            </div>}
            {spec ? <FullTestReview key={`${reviewKey}:${againstRun}`} feature={selected.name} file={spec.file} runId={againstRun || !selected.feature ? run?.runId ?? focusRunId ?? undefined : undefined} focus={focus} onFocus={onFocus} revision={JSON.stringify(spec)} /> : <p role={runError ? 'alert' : 'status'} className="p-4 text-sm">{runError ?? 'Loading test files…'}</p>}
          </section>
        </div>}
      </Modal>
      <Modal open={hintOpen} portal onClose={() => setHintOpen(false)} title="A hint, not a verdict" width={500}>
        <p className="px-5 py-4 text-xs leading-relaxed text-secondary" data-testid="dirty-review-hint-copy">{WEAKER_HINT_COPY}</p>
      </Modal>
    </>
  )
}
