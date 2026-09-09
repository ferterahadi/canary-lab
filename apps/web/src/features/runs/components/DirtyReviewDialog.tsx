import { useEffect, useRef, useState } from 'react'
import type { DirtySpecSummary, Feature, RunDetail, RunIndexEntry } from '@/shared/api/types'
import * as api from '@/shared/api/client'
import { shortRunRef } from '@/shared/lib/format'
import { Modal } from '@/shared/ui/atoms'
import { EmptyGlyph, EmptyState } from '@/shared/ui/EmptyState'
import { useRun } from '../state/RunsContext'
import { WEAKER_HINT_COPY, featureTone, specTone } from '../utils/spec-integrity'
import { SpecChangeReview, SpecToneChip } from './SpecChangeReview'

interface Props {
  features: Feature[]
  focusFeature?: string | null
  focusRunId?: string | null
  focusRunDetail?: RunDetail | null
  pendingRuns?: RunIndexEntry[]
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
export function DirtyReviewDialog({ features, pendingRuns = [], focusFeature, focusRunId, focusRunDetail, onClose }: Props) {
  const pendingByFeature = new Map<string, RunIndexEntry>()
  for (const run of pendingRuns) {
    if (!pendingByFeature.has(run.feature) || run.runId === focusRunId) pendingByFeature.set(run.feature, run)
  }
  const dirty = features.filter((feature) => feature.dirty?.status === 'dirty')
  const cards: ReviewSuite[] = [
    ...dirty.map((feature) => ({ name: feature.name, feature, run: pendingByFeature.get(feature.name) })),
    ...[...pendingByFeature.values()].filter((run) => !dirty.some((feature) => feature.name === run.feature))
      .map((run) => ({ name: run.feature, feature: null, run })),
  ].sort((a, b) => Number(b.name === focusFeature) - Number(a.name === focusFeature)
    || (focusRunId ? Number(b.run?.runId === focusRunId) - Number(a.run?.runId === focusRunId) : 0)
    || cardRank(a) - cardRank(b) || a.name.localeCompare(b.name))
  const [picked, setPicked] = useState<{ feature: string; file?: string } | null>(null)
  const selected = cards.find((card) => card.name === picked?.feature) ?? cards[0]
  const { detail: loadedDetail, error: runError } = useRun(selected?.run?.runId ?? null)
  const detail = loadedDetail ?? focusRunDetail
  const specs = selected ? [...specsFor(selected, detail)].sort((a, b) => Number(specTone(b) === 'weaker') - Number(specTone(a) === 'weaker') || a.file.localeCompare(b.file)) : []
  const spec = specs.find((item) => selected.name === picked?.feature && item.file === picked.file) ?? specs[0]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hintOpen, setHintOpen] = useState(false)
  const [workspaceOpenError, setWorkspaceOpenError] = useState<string | null>(null)
  const hadCards = useRef(false)
  useEffect(() => {
    if (cards.length > 0) hadCards.current = true
    else if (hadCards.current) onClose()
  }, [cards.length, onClose])
  useEffect(() => { setPicked(null) }, [focusFeature, focusRunId])

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
    setError(null)
  }
  const weaker = specs.some((item) => specTone(item) === 'weaker')
  const tone = spec ? specTone(spec) : selected?.feature ? featureTone(selected.feature) : null
  const run = selected?.run

  return (
    <>
      <Modal
        open
        portal
        onClose={onClose}
        title="Tests changed"
        description={selected ? `${selected.name} · Review the changes before relying on the previous result.` : 'Review changed test files and the assertions they enforce.'}
        ariaLabel="Changed test files"
        testId="dirty-review-dialog"
        width={1080}
        height={680}
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
        headerActions={<button type="button" onClick={() => { void openWorkspace() }} aria-label="Open workspace in editor" title="Open workspace in editor" className="cl-icon-button h-7 w-7 shrink-0">↗</button>}
        subheader={<>
          {workspaceOpenError && <p role="alert" className="px-5 py-2 text-xs text-danger">{workspaceOpenError}</p>}
          {weaker && <div className="flex items-center gap-3 border-b border-line px-5 py-3 text-[11px] text-secondary">
            <p className="flex-1"><strong className="font-medium text-danger">Possible weakening.</strong> Advisory only; the hint does not change the run verdict.</p>
            <button className="shrink-0 text-primary underline decoration-line-strong underline-offset-4" onClick={() => setHintOpen(true)}>About this hint</button>
          </div>}
        </>}
        footer={selected && <div className="flex w-full flex-wrap items-center justify-between gap-3" data-testid="dirty-review-actions">
          <div className="max-w-sm text-[11px] leading-relaxed text-secondary">
            {run ? <p data-testid={`dirty-review-pending-${selected.name}`}>Pending against run {shortRunRef(run.runId)} · {run.pendingSpecEdits ?? 0} {run.pendingSpecEdits === 1 ? 'edit' : 'edits'} not executed — the verdict is from the run-start snapshot</p> : <p>Committing saves edits in Git. It does not adopt them into an active run.</p>}
            {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {selected.feature && <button className="cl-button px-3 py-1.5 text-xs" disabled={busy} title="Stage and commit exactly these spec files" onClick={() => { void act(() => api.commitDirtySpecs(selected.name)) }}>Commit changes</button>}
            {run && <>
              <button className="cl-button px-3 py-1.5 text-xs" disabled={busy} onClick={() => { void act(() => api.restoreSpecEdits(run.runId)) }}>Restore original tests</button>
              <button className="cl-button-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => { void act(() => api.adoptSpecEdits(run.runId)) }}>Adopt &amp; rerun</button>
            </>}
          </div>
        </div>}
      >
        {cards.length === 0 ? <div className="p-5"><EmptyState icon={EmptyGlyph.journal} title="No changed test files" body="Every suite matches its comparison baseline, and no live run is holding an edit it has not executed." testId="dirty-review-empty" /></div> : <div className="cl-dialog-panes min-h-0 flex-1">
          <nav className="cl-dialog-rail overflow-auto p-3 scrollbar-thin" aria-label="Changed test files">
            <p className="mb-3 px-2 text-[10px] uppercase tracking-wider text-secondary">Suites · {cards.length}</p>
            {cards.map((card) => {
              const files = specsFor(card, card === selected ? detail : focusRunDetail)
              return <div key={card.name} className="mb-4" data-testid={`dirty-review-suite-${card.name}`}>
                <p className="mb-1 break-words px-2 text-xs font-medium">{card.name}</p>
                {files.length ? files.map((file) => <button key={file.file} type="button" disabled={busy} aria-pressed={card.name === selected.name && file.file === spec?.file} className="cl-review-file" onClick={() => choose(card.name, file.file)}>
                  <span className="block break-words font-mono text-[11px]">{file.file}</span>
                  <span className="mt-2 flex flex-wrap items-center gap-2"><SpecToneChip tone={specTone(file)} /><span className="text-[10px] text-secondary">{file.affectedTests.length} tests</span></span>
                </button>) : <button className="cl-review-file text-xs" disabled={busy} aria-pressed={card.name === selected.name} onClick={() => choose(card.name)}>Pending test edits</button>}
              </div>
            })}
          </nav>
          <section className="min-h-0 min-w-0 overflow-auto p-5 scrollbar-thin" style={{ scrollbarGutter: 'stable' }} data-testid={`dirty-review-card-${selected.name}`} data-pending={run ? 'true' : undefined} data-tone={tone ?? undefined}>
            {spec ? <SpecChangeReview key={`${selected.name}:${spec.file}`} spec={spec} /> : <p role={runError ? 'alert' : undefined} className="text-xs text-secondary">{runError ?? 'Loading changed test files…'}</p>}
          </section>
        </div>}
      </Modal>
      <Modal open={hintOpen} portal onClose={() => setHintOpen(false)} title="A hint, not a verdict" width={500}>
        <p className="px-5 py-4 text-xs leading-relaxed text-secondary" data-testid="dirty-review-hint-copy">{WEAKER_HINT_COPY}</p>
      </Modal>
    </>
  )
}
