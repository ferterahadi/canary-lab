// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail, RunIndexEntry } from '@/shared/api/types'
import { RunRow } from './RunRow'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run: RunIndexEntry = { runId: 'run-z6kc', feature: 'checkout', startedAt: '2026-05-31T10:00:00.000Z', status: 'failed' }
const detail = {
  runId: 'run-z6kc',
  manifest: { services: [{ allocatedPorts: { api: 4123 } }] },
  summary: { total: 12, passed: 9, failed: [] },
} as unknown as RunDetail

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

function renderRow(props: Partial<Parameters<typeof RunRow>[0]> = {}): void {
  act(() => {
    root.render(<ul><RunRow run={run} detail={detail} onSelect={() => {}} {...props} /></ul>)
  })
}

describe('RunRow (R80 hero props)', () => {
  it('default: shows the feature, ports, and the pass count inline', () => {
    renderRow()
    const text = container.textContent ?? ''
    expect(text).toContain('checkout')
    expect(text).toContain(':4123')
    expect(text).toContain('9/12 passed')
  })

  it('primaryLabel overrides the identity line', () => {
    renderRow({ primaryLabel: 'Run z6kc' })
    expect(container.textContent).toContain('Run z6kc')
    // The feature name is no longer the bold identity line.
    expect(container.querySelector('span[style*="font-weight: 500"]')?.textContent).toBe('Run z6kc')
  })

  it('showPorts=false hides the allocated-ports segment', () => {
    renderRow({ showPorts: false })
    expect(container.textContent).not.toContain(':4123')
  })

  it('marker appends an extra meta segment (the run ordinal)', () => {
    renderRow({ marker: 'run 2 of 2' })
    expect(container.textContent).toContain('run 2 of 2')
  })

  it("passCount 'promoted' lifts the pass count out of the meta line", () => {
    renderRow({ passCount: 'promoted' })
    // Still shown once, as its own promoted segment.
    expect(container.textContent).toContain('9/12 passed')
    const occurrences = (container.textContent?.match(/9\/12 passed/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('calls onSelect with the run when clicked', () => {
    const onSelect = vi.fn()
    renderRow({ onSelect })
    act(() => { container.querySelector('button')?.click() })
    expect(onSelect).toHaveBeenCalledWith(run)
  })
})
