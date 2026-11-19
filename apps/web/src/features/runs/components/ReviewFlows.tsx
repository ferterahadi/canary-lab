import type { ReactNode } from 'react'
import { reviewCaseKey, type ReviewDeclarationPair, type ReviewSource, type ReviewTestSource } from '@shared/test-review'
import type { TestViewSide, TestViewSideLabels } from '@shared/test-view/render-model'
import type { CardInspection } from '@/shared/lib/workspace-view-state'
import { TestPresentation } from '@/shared/ui/TestPresentation'

interface Sources {
  before: ReviewSource
  after: ReviewSource
  declarationPairs?: ReviewDeclarationPair[]
}

export interface ReviewInspection { side: TestViewSide; flow: CardInspection }

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
  const pairs: ReviewDeclarationPair[] = sources.declarationPairs ?? [
    ...Array.from(tests.after.keys(), after => ({ after })),
    ...Array.from(tests.before.keys(), before => ({ before })),
  ]
  const target = selectedCase ?? (inspection && { side: inspection.side, card: inspection.flow.card })
  const index = target ? pairs.findIndex(pair => pair[target.side] === target.card) : 0
  const selected = pairs[index]
  const choose = (pair: ReviewDeclarationPair) => {
    const side = pair.after ? 'after' : 'before'
    onInspect({ side, flow: { card: pair[side]!, mode: 'visual' } })
  }
  const name = (side: TestViewSide, pair: ReviewDeclarationPair) => tests[side].get(pair[side] ?? '')?.name
  return <div className="min-h-0 overflow-auto p-2">
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
          {test ? <ReviewFlowSide test={test} source={sources[side].source} side={side}
            inspection={inspection?.side === side && inspection.flow.card === key ? inspection.flow : undefined}
            onInspect={onInspect} /> : <p className="text-xs text-secondary">{sources[side].parseError || !sources.declarationPairs
              ? 'Matching declaration unavailable for this source.' : side === 'before' ? 'Added test · absent before this change.' : 'Removed test · absent after this change.'}</p>}
        </section>
      })}
    </div> : <p role="status">The selected declaration is unavailable in these source versions.</p>}
  </div>
}

function ReviewFlowSide({ test, source, side, inspection, onInspect }: {
  test: ReviewTestSource; source: string; side: TestViewSide; inspection?: CardInspection
  onInspect: (selection: ReviewInspection) => void
}) {
  const graph = test.readable.graph
  const body = graph?.sections[0]?.definition
  if (graph?.schemaVersion !== 1 || graph.origin.kind !== side || !body || body.startOffset == null || body.endOffset == null)
    return <p role="status">No source-backed graph for this test. Open File comparison to inspect the source.</p>
  const revision = graph.revisions[body.file]
  return <>
    <p className="text-xs text-secondary" title={revision}>{test.name} · {body.file}:{test.line} · {revision?.slice(0, 12)}</p>
    <TestPresentation view="single" sourceFile={body.file} inspection={inspection ?? { mode: 'visual' }}
      onInspection={value => onInspect({ side, flow: { ...value, card: reviewCaseKey(test) } })}
      test={{ ...test, steps: [], bodyLine: body.startLine, bodySource: source.slice(body.startOffset, body.endOffset) }} />
  </>
}
