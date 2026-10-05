// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RunManifest } from '@shared/run-manifest'
import { RecordedTestChanges } from './RecordedTestChanges'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
const manifest: RunManifest = {
  runId: 'old-run', feature: 'checkout', status: 'aborted', startedAt: '2026-01-01T00:00:00Z', services: [], healCycles: 1,
  specEdits: { checkedAt: '2026-01-01T00:05:00Z', pending: [{ file: 'e2e/access.spec.ts', change: 'modified', affectedTests: ['credentials stay private'] }], adopted: [],
    reviewDecisions: [{ at: '2026-01-01T00:06:00Z', revision: 'old-revision', decision: 'approved-for-new-run' }] },
}
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

it.each(['passed', 'failed', 'aborted'] as const)('explains historical changes for %s and exposes comparison without changing the receipt', (status) => {
  const compare = vi.fn()
  act(() => root.render(<RecordedTestChanges manifest={{ ...manifest, status }} onCompare={compare} />))
  expect(container.textContent).toContain('Recorded test changes')
  expect(container.textContent).toContain('not a current outstanding-review count')
  expect(container.textContent).toContain('e2e/access.spec.ts')
  expect(container.textContent).toContain('credentials stay private')
  expect(container.querySelector('time')?.dateTime).toBe(manifest.specEdits!.checkedAt)
  act(() => container.querySelector('button')!.click())
  expect(compare).toHaveBeenCalledOnce()
  expect(manifest.specEdits!.reviewDecisions![0].decision).toBe('approved-for-new-run')
})

it('updates an already open view on completion and on refreshed recorded changes', () => {
  act(() => root.render(<RecordedTestChanges manifest={{ ...manifest, status: 'healing' }} />))
  expect(container.textContent).toBe('')
  act(() => root.render(<RecordedTestChanges manifest={manifest} />))
  expect(container.textContent).toContain('e2e/access.spec.ts')
  act(() => root.render(<RecordedTestChanges manifest={{ ...manifest, specEdits: { ...manifest.specEdits!, pending: [] } }} />))
  expect(container.textContent).toBe('')
})
