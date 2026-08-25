// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSummary, RunSummaryFailedEntry } from '@/shared/api/types'
import { FailingTests } from './FailingTests'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onOpenTest.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const failed = (over: Partial<RunSummaryFailedEntry> = {}): RunSummaryFailedEntry => ({
  id: 't1',
  name: 'test-case-req-r4-path-sad-a-request-with-no-bot-challenge-token-is-refused',
  location: '/Users/me/ws/features/otp/e2e/otp-abuse-guards.spec.ts:199',
  durationMs: 2400,
  error: { message: 'expect(received).toBe(expected)\n\nExpected: 429\nReceived: 200', snippet: '  > 199 |   expect(res.status()).toBe(429)' },
  ...over,
})

const onOpenTest = vi.fn()

const render = (entries: RunSummaryFailedEntry[], knownTests?: RunSummary['knownTests']): void => {
  act(() => root.render(<FailingTests failing={entries} knownTests={knownTests} onOpenTest={onOpenTest} />))
}

describe('FailingTests', () => {
  it('renders nothing when there is nothing failing', () => {
    render([])
    expect(container.querySelector('[data-testid="run-hero-failing"]')).toBeNull()
  })

  it('recovers the real title from knownTests and lifts its @req/@path tags into chips', () => {
    render([failed()], [{
      id: 't1',
      name: 'test-case-req-r4-path-sad-a-request-with-no-bot-challenge-token-is-refused',
      title: '@req-R4 @path-sad a request with no bot-challenge token is refused',
      location: '/Users/me/ws/features/otp/e2e/otp-abuse-guards.spec.ts:199',
    }])
    const text = container.textContent ?? ''
    // The human sentence survives whole — hyphenated words included.
    expect(text).toContain('a request with no bot-challenge token is refused')
    expect(text).toContain('@req-R4')
    expect(text).toContain('@path-sad')
    // Tags are chips, not part of the title line.
    expect(text).not.toContain('@req-R4 @path-sad a request')
  })

  it('de-slugifies the name when the summary carried no knownTests', () => {
    render([failed()])
    const text = container.textContent ?? ''
    expect(text).toContain('a request with no bot challenge token is refused')
    expect(text).toContain('@req-R4') // slugged `r4` comes back uppercase
    expect(text).toContain('@path-sad')
  })

  // R82: the stage is the run's SUMMARY. The assertion error, the code snippet
  // and the spec are run-detail content, so no row expands and none of that is
  // rendered here — clicking a row goes to the run detail instead.
  it('renders no expandable detail — no assertion error, snippet or open-spec control', () => {
    render([failed()])
    expect(container.querySelector('[data-testid^="failure-detail-"]')).toBeNull()
    expect(container.querySelector('[data-testid^="failing-toggle-"]')).toBeNull()
    expect(container.querySelector('[data-testid^="failure-open-"]')).toBeNull()
    const text = container.textContent ?? ''
    expect(text).not.toContain('Expected: 429')
    expect(text).not.toContain('expect(res.status()).toBe(429)')
  })

  it('opens the clicked failure on the run detail, keyed by the failed entry name', () => {
    const second = failed({ id: 't2', name: 'test-case-req-r5-path-happy-clean-number-is-allowed' })
    render([failed(), second])
    act(() => { container.querySelector<HTMLElement>('[data-testid="failing-open-test-case-req-r5-path-happy-clean-number-is-allowed"]')?.click() })
    expect(onOpenTest).toHaveBeenCalledWith('test-case-req-r5-path-happy-clean-number-is-allowed')
  })

  it('shows the readable location tail, duration and retry count', () => {
    render([failed({ retry: 1 })])
    const text = container.textContent ?? ''
    expect(text).toContain('e2e/otp-abuse-guards.spec.ts:199')
    expect(text).toContain('2.4s')
    expect(text).toContain('retry 1')
  })

  it('renders rows as inert text when no opener is supplied', () => {
    act(() => root.render(<FailingTests failing={[failed()]} />))
    expect(container.querySelector('[data-testid^="failing-open-"]')).toBeNull()
    expect(container.textContent).toContain('a request with no bot challenge token is refused')
  })
})
