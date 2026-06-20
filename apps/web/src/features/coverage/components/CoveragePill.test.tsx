// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverageJobIndexEntry } from '../../../api/types'
import { CoveragePill } from './CoveragePill'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const job = (over: Partial<CoverageJobIndexEntry>): CoverageJobIndexEntry => ({
  jobId: 'j1', feature: 'checkout', kind: 'coverage', status: 'running', startedAt: '2026-01-01', ...over,
})

const FEATURES = [{ name: 'checkout' }, { name: 'billing' }]

function render(jobs: CoverageJobIndexEntry[], onOpenFeature = vi.fn(), features = FEATURES) {
  act(() => { root.render(<CoveragePill jobs={jobs} features={features} onOpenFeature={onOpenFeature} />) })
  return onOpenFeature
}

describe('CoveragePill (always-visible launcher)', () => {
  it('stays visible even when idle (no jobs)', () => {
    render([])
    expect(container.querySelector('[data-testid="coverage-pill"]')).toBeTruthy()
    expect(container.textContent).toContain('Coverage')
  })

  it('takes the in-flight treatment while a job runs and labels the kind', () => {
    render([job({ kind: 'summary', status: 'running' })])
    expect(container.textContent).toContain('summarizing')
  })

  it('idle click opens a menu listing features to open coverage', () => {
    const onOpen = render([])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="coverage-pill"] button')?.click() })
    expect(document.body.querySelector('[data-testid="coverage-task-menu"]')).toBeTruthy()
    act(() => { document.body.querySelector<HTMLButtonElement>('[data-testid="coverage-open-billing"]')?.click() })
    expect(onOpen).toHaveBeenCalledWith('billing')
  })

  it('shows a live status on the feature whose job is running and resumes on click', () => {
    const onOpen = render([job({ jobId: 'j1', feature: 'checkout', kind: 'coverage', status: 'running' })])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="coverage-pill"] button')?.click() })
    const checkoutRow = document.body.querySelector('[data-testid="coverage-open-checkout"]')
    expect(checkoutRow?.textContent).toContain('mapping…') // live phase from the running coverage job
    act(() => { document.body.querySelector<HTMLButtonElement>('[data-testid="coverage-open-checkout"]')?.click() })
    expect(onOpen).toHaveBeenCalledWith('checkout')
  })
})
