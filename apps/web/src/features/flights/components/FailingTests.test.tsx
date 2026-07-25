// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSummary, RunSummaryFailedEntry } from '../../../shared/api/types'
import { FailingTests } from './FailingTests'

const mocks = vi.hoisted(() => ({ openEditor: vi.fn() }))
vi.mock('../../../shared/api/client', () => mocks)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.openEditor.mockReset().mockResolvedValue({ opened: true, editor: 'vscode' })
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

const render = (entries: RunSummaryFailedEntry[], knownTests?: RunSummary['knownTests']): void => {
  act(() => root.render(<FailingTests failing={entries} knownTests={knownTests} />))
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

  it('shows the assertion error and snippet for the first (worst) failure without a click', () => {
    render([failed()])
    const detail = container.querySelector('[data-testid^="failure-detail-"]')?.textContent ?? ''
    expect(detail).toContain('Expected: 429')
    expect(detail).toContain('expect(res.status()).toBe(429)')
  })

  it('keeps later failures collapsed until they are expanded', () => {
    const second = failed({ id: 't2', name: 'test-case-req-r5-path-happy-clean-number-is-allowed', error: { message: 'timed out waiting for the OTP' } })
    render([failed(), second])
    expect(container.querySelector('[data-testid="failure-detail-test-case-req-r5-path-happy-clean-number-is-allowed"]')).toBeNull()
    act(() => { container.querySelector<HTMLElement>('[data-testid="failing-toggle-test-case-req-r5-path-happy-clean-number-is-allowed"]')?.click() })
    expect(container.textContent).toContain('timed out waiting for the OTP')
  })

  it('shows the readable location tail, duration and retry count', () => {
    render([failed({ retry: 1 })])
    const text = container.textContent ?? ''
    expect(text).toContain('e2e/otp-abuse-guards.spec.ts:199')
    expect(text).toContain('2.4s')
    expect(text).toContain('retry 1')
  })

  it('opens the failing spec at its line', () => {
    render([failed()])
    act(() => { container.querySelector<HTMLElement>('[data-testid^="failure-open-"]')?.click() })
    expect(mocks.openEditor).toHaveBeenCalledWith({
      file: '/Users/me/ws/features/otp/e2e/otp-abuse-guards.spec.ts',
      line: 199,
    })
  })

  it('never dead-ends on a failure with no captured error', () => {
    render([failed({ error: undefined })])
    expect(container.textContent).toContain('No assertion error was captured')
  })
})
