import type { ReactNode } from 'react'
import { REVIEW_FILE_SCOPE, reviewCaseKey, type ReviewDeclarationPair, type ReviewSource, type ReviewTestSource } from '@shared/test-review'
import type { TestViewSide, TestViewSideLabels } from '@shared/test-view/render-model'
import type { CardInspection, ComparisonJump } from '@/shared/lib/workspace-view-state'
import { ComparedFlowReader, hasComparisonFlow } from '@/shared/ui/ComparedFlowReader'
import { TestPresentation } from '@/shared/ui/TestPresentation'

interface Sources {
  before: ReviewSource
  after: ReviewSource
  declarationPairs?: ReviewDeclarationPair[]
}

export type ReviewInspection = ComparisonJump

export function ReviewFlows({ sources, labels, inspection, onInspect, onReturn, toolbar, selectedCase }: {
  sources: Sources
  labels: TestViewSideLabels
  inspection?: ReviewInspection
  onInspect: (selection: ReviewInspection) => void
  onReturn: () => void
  selectedCase?: { side: TestViewSide; card: string }
  toolbar?: ReactNode
}) {
  const tests = {
    before: new Map(sources.before.tests.map(test => [reviewCaseKey(test), test])),
    after: new Map(sources.after.tests.map(test => [reviewCaseKey(test), test])),
  }
  // Older reviews do not carry the declaration match. Keep each source
  // inspectable without inferring a counterpart from a title or position.
  const testPairs: ReviewDeclarationPair[] = sources.declarationPairs ?? [
    ...Array.from(tests.after.keys(), after => ({ after })),
    ...Array.from(tests.before.keys(), before => ({ before })),
  ]
  const filePair: Partial<Record<TestViewSide, string>> = {}
  for (const side of ['before', 'after'] as const) {
    const readable = sources[side].fileFlow
    const range = readable?.graph?.sections[0]?.definition
    if (readable && range && readable.graph?.origin.kind === side) {
      tests[side].set(REVIEW_FILE_SCOPE, { readable, name: readable.title, line: 1, endLine: range.endLine })
      filePair[side] = REVIEW_FILE_SCOPE
    }
  }
  const pairs = filePair.before || filePair.after ? [...testPairs, filePair] : testPairs
  const target = inspection ? { side: inspection.side, card: inspection.flow.card } : selectedCase
  const index = target ? pairs.findIndex(pair => pair[target.side] === target.card) : 0
  const selected = pairs[index]
  const choose = (pair: Partial<Record<TestViewSide, string>>) => {
    const side = pair.after ? 'after' : 'before'
    onInspect({ side, flow: { card: pair[side]!, mode: 'visual' } })
  }
  const name = (side: TestViewSide, pair: Partial<Record<TestViewSide, string>>) => tests[side].get(pair[side] ?? '')?.name
  // Expand directly from an aligned pane returns to that pane; expanding from a
  // chosen test returns to the same test and preserves its helper call history.
  const update = (next: ReviewInspection) =>
    inspection?.flow.returnToFile && !next.flow.expanded ? onReturn() : onInspect({ ...next,
      flow: { ...next.flow, ...(inspection?.flow.returnToFile && { returnToFile: true }) } })
  if (inspection?.flow.mode === 'visual' && selected?.before && selected.after && hasComparisonFlow(sources, selected)) return <>
    {!inspection.flow.expanded && <div className="cl-flow-picker"><button type="button" onClick={onReturn}>File comparison</button>{toolbar}</div>}
    <ComparedFlowReader review={sources} cards={selected} inspection={inspection} labels={labels} onInspect={update}
      ariaLabel="Combined flow comparison"/>
  </>
  return <div className="min-h-0 overflow-auto p-2" hidden={!!inspection?.flow.expanded}>
    <div className="cl-flow-picker">
      {!selectedCase && <label>Test <select value={index} onChange={event => choose(pairs[Number(event.target.value)])}>
        {index < 0 && <option value={-1}>Selection unavailable</option>}
        {pairs.map((pair, i) => {
          const before = name('before', pair)
          const after = name('after', pair)
          const label = before && after && before !== after ? before + ' → ' + after : after ?? before
          return <option key={i} value={i}>{label} · line {(tests.after.get(pair.after ?? '') ?? tests.before.get(pair.before ?? ''))?.line}</option>
        })}
      </select></label>}
      <button type="button" onClick={onReturn}>File comparison</button>{toolbar}
    </div>
    {selected ? <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))' }}>
      {(['before', 'after'] as const).map(side => {
        const key = selected[side]
        const test = key && tests[side].get(key)
        return <section key={side} aria-label={labels[side]} className="min-w-0">
          <h3 className="text-sm font-medium">{labels[side]}</h3>
          {test ? <ReviewFlowSide test={test} source={sources[side].source} side={side} card={key!}
            inspection={inspection?.side === side && inspection.flow.card === key ? inspection.flow : undefined}
            onInspect={update} /> : <p className="text-xs text-secondary">{sources[side].parseError || !sources.declarationPairs
              ? 'Matching declaration unavailable for this source.' : side === 'before' ? 'Added test · absent before this change.' : 'Removed test · absent after this change.'}</p>}
        </section>
      })}
    </div> : <p role="status">The selected declaration is unavailable in these source versions.</p>}
  </div>
}

function ReviewFlowSide({ test, source, side, card, inspection, onInspect }: {
  test: ReviewTestSource; source: string; card: string; side: TestViewSide; inspection?: CardInspection
  onInspect: (selection: ReviewInspection) => void
}) {
  const graph = test.readable.graph
  const body = graph?.sections[0]?.definition
  if (graph?.schemaVersion !== 1 || graph.origin.kind !== side || !body || body.startOffset == null || body.endOffset == null)
    return <p role="status">No source-backed graph for this test. Open File comparison to inspect the source.</p>
  const revision = graph.revisions[body.file]
  return <>
    {!inspection?.expanded && <p className="text-xs text-secondary" title={revision}>{test.name} · {body.file}:{test.line} · {revision?.slice(0, 12)}</p>}
    <TestPresentation view="single" overviewLabel={card === REVIEW_FILE_SCOPE ? 'File overview' : undefined} sourceFile={body.file} inspection={inspection ?? { mode: 'visual' }}
      onInspection={value => onInspect({ side, flow: { ...value, card } })}
      test={{ ...test, steps: [], bodyLine: body.startLine, bodySource: source.slice(body.startOffset, body.endOffset) }} />
  </>
}
