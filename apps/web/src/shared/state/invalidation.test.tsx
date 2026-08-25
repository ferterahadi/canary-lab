// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InvalidationProvider, useInvalidation, useInvalidationKey } from './invalidation'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// A leaf that surfaces its subscribed version + a render counter, so a test can
// assert both the value AND whether an unrelated bump re-rendered it.
function Probe({ topic, scope, testid }: { topic: 'coverage' | 'ports' | 'journal'; scope?: string; testid: string }) {
  const key = useInvalidationKey(topic, scope)
  return <span data-testid={testid}>{key}</span>
}

let invalidate: ReturnType<typeof useInvalidation>['invalidate']
function Capture() {
  invalidate = useInvalidation().invalidate
  return null
}

describe('useInvalidationKey', () => {
  it('reads 0 with no provider above it (isolated unit-test default)', async () => {
    await act(async () => root.render(<Probe topic="coverage" testid="k" />))
    expect(container.querySelector('[data-testid="k"]')?.textContent).toBe('0')
  })

  it('starts at 0 and increments only its own topic on invalidate', async () => {
    await act(async () => {
      root.render(
        <InvalidationProvider>
          <Capture />
          <Probe topic="coverage" testid="cov" />
          <Probe topic="ports" testid="ports" />
        </InvalidationProvider>,
      )
    })
    expect(container.querySelector('[data-testid="cov"]')?.textContent).toBe('0')

    await act(async () => invalidate('coverage'))
    expect(container.querySelector('[data-testid="cov"]')?.textContent).toBe('1')
    // The other topic is untouched.
    expect(container.querySelector('[data-testid="ports"]')?.textContent).toBe('0')
  })

  it('keeps scopes of the same topic independent', async () => {
    await act(async () => {
      root.render(
        <InvalidationProvider>
          <Capture />
          <Probe topic="journal" scope="run-a" testid="a" />
          <Probe topic="journal" scope="run-b" testid="b" />
        </InvalidationProvider>,
      )
    })
    await act(async () => invalidate('journal', 'run-a'))
    expect(container.querySelector('[data-testid="a"]')?.textContent).toBe('1')
    expect(container.querySelector('[data-testid="b"]')?.textContent).toBe('0')
  })
})

describe('useInvalidation', () => {
  it('throws when used outside the provider (publishers must be wrapped)', () => {
    expect(() => {
      act(() => root.render(<Capture />))
    }).toThrow(/InvalidationProvider/)
  })
})
