import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { collidingTests } from '@shared/__fixtures__/summary-test-identity'
import type { PlaywrightPlaybackEvent } from '@shared/playback'
import { FailingTests } from '@/features/flights/components/FailingTests'
import type { RunOpenTarget } from '@/shared/lib/workspace-view-state'
import type { RunDetail } from '@shared/run-detail'
import { ResultsFixesTab } from '@/features/runs/components/ResultsFixesTab'
import { useResultsFocus } from '@/features/runs/state/use-results-focus'
import type { ResultsSelection } from '@/features/runs/utils/results-fixes'

// The Results & Fixes panel as RunDetailColumn composes it: a routed focus
// resolves into the reader's selection, which opens one accordion row.
function Results({ detail, focus }: { detail: RunDetail; focus: RunOpenTarget }) {
  const [selection, setSelection] = useState<ResultsSelection>({ caseKey: null })
  useResultsFocus(detail.runId, detail, focus, (caseKey) => setSelection({ caseKey }))
  return <ResultsFixesTab detail={detail} view="tests" onViewChange={() => {}} selection={selection} onSelectionChange={setSelection} repairEvidence />
}

function detailOf(playbackEvents: PlaywrightPlaybackEvent[], summary?: RunDetail['summary']): RunDetail {
  return {
    runId: 'run-1',
    manifest: { runId: 'run-1', feature: 'checkout', startedAt: '2026-01-01T00:00:00Z', status: 'failed', healCycles: 0, services: [] },
    playbackEvents,
    ...(summary ? { summary } : {}),
  }
}

it('opens exactly the clicked failure, including delayed playback and a second selection', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const events: PlaywrightPlaybackEvent[] = collidingTests.map((test) => ({
    type: 'test-end', test, time: '2026-01-01T00:00:00Z', status: 'failed', passed: false, durationMs: 1, retry: 0,
  }))
  function View({ ready }: { ready: boolean }) {
    const [target, setTarget] = useState<RunOpenTarget>({})
    return <><FailingTests failing={collidingTests} knownTests={collidingTests} onOpenTest={(test, identity) => setTarget({ test, ...identity })} />
      <Results detail={detailOf(ready ? events : [], { complete: true, total: 2, passed: 0, failed: collidingTests, knownTests: collidingTests })} focus={target} /></>
  }
  try {
    act(() => root.render(<View ready={false} />))
    act(() => container.querySelectorAll<HTMLButtonElement>('[data-testid^="failing-open-"]')[1].click())
    act(() => root.render(<View ready />))
    expect(container.querySelectorAll('[data-open]')).toHaveLength(1)
    expect(container.querySelector('[data-open]')?.textContent).toContain('Checkout?')
    act(() => container.querySelectorAll<HTMLButtonElement>('[data-testid^="failing-open-"]')[0].click())
    expect(container.querySelectorAll('[data-open]')).toHaveLength(1)
    expect(container.querySelector('[data-open]')?.textContent).toContain('Checkout!')
    // A bare name two cases share opens neither.
    act(() => root.render(<Results key="bare" detail={detailOf(events)} focus={{ test: collidingTests[0].name }} />))
    expect(container.querySelectorAll('[data-open]')).toHaveLength(0)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
