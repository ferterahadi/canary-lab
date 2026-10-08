import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { collidingTests } from '@shared/__fixtures__/summary-test-identity'
import type { PlaywrightPlaybackEvent } from '@shared/playback'
import { FailingTests } from '@/features/flights/components/FailingTests'
import type { RunOpenTarget } from '@/shared/lib/workspace-view-state'
import { PlaywrightPlayback } from '@/features/runs/components/RunPlaybackPanels'

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
      <PlaywrightPlayback events={ready ? events : []} summary={{ complete: true, total: 2, passed: 0, failed: collidingTests, knownTests: collidingTests }}
        focusTest={target.test} focusTestId={target.testId} focusTestLocation={target.testLocation} /></>
  }
  try {
    act(() => root.render(<View ready={false} />))
    act(() => container.querySelectorAll<HTMLButtonElement>('[data-testid^="failing-open-"]')[1].click())
    act(() => root.render(<View ready />))
    expect(container.querySelectorAll('[data-focus-test]')).toHaveLength(1)
    expect(container.querySelector('[data-focus-test]')?.textContent).toContain('Checkout?')
    act(() => container.querySelectorAll<HTMLButtonElement>('[data-testid^="failing-open-"]')[0].click())
    expect(container.querySelectorAll('[data-focus-test]')).toHaveLength(1)
    expect(container.querySelector('[data-focus-test]')?.textContent).toContain('Checkout!')
    act(() => root.render(<PlaywrightPlayback events={events} focusTest={collidingTests[0].name} />))
    expect(container.querySelectorAll('[data-focus-test]')).toHaveLength(0)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
