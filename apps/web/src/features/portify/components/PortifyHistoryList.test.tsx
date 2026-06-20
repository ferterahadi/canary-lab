// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortifyIndexEntry } from '../../../api/client'

const workflows: PortifyIndexEntry[] = []
vi.mock('../state/PortifyContext', () => ({
  usePortify: () => ({ workflows }),
}))
vi.mock('../../../api/client', () => ({
  removePortify: vi.fn(async () => ({ workflowId: 'w1', removed: true as const })),
}))

import * as api from '../../../api/client'
import { PortifyHistoryList } from './PortifyHistoryList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  workflows.length = 0
  vi.clearAllMocks()
})

const entry = (over: Partial<PortifyIndexEntry>): PortifyIndexEntry => ({
  workflowId: 'w1', feature: 'cns', status: 'saved', branch: 'canary/dynamic-ports-cns', startedAt: '2026-06-01T10:00:00Z', ...over,
})

async function render(onOpenPortify = vi.fn()) {
  await act(async () => { root.render(<PortifyHistoryList onOpenPortify={onOpenPortify} />) })
  return { onOpenPortify }
}

function rowFor(feature: string): HTMLElement {
  const row = [...container.querySelectorAll('[role="button"]')].find((el) => el.textContent?.includes(feature))
  if (!row) throw new Error(`row not found for ${feature}`)
  return row as HTMLElement
}

describe('PortifyHistoryList', () => {
  it('shows an empty hint when there is no history', async () => {
    await render()
    expect(container.textContent).toContain('No Portify runs yet')
  })

  it('lists all workflows with their status label', async () => {
    workflows.push(entry({ workflowId: 'w1', feature: 'cns', status: 'saved' }))
    workflows.push(entry({ workflowId: 'w2', feature: 'oms', status: 'editing', startedAt: '2026-06-02T10:00:00Z' }))
    await render()
    expect(container.textContent).toContain('cns')
    expect(container.textContent).toContain('saved')
    expect(container.textContent).toContain('editing')
    // No merge/branch affordance in the ephemeral-overlay model.
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Copy merge'))).toBe(false)
  })

  it('scopes the list to one feature when the feature prop is set', async () => {
    workflows.push(entry({ workflowId: 'w1', feature: 'cns', status: 'saved' }))
    workflows.push(entry({ workflowId: 'w2', feature: 'oms', status: 'saved', startedAt: '2026-06-02T10:00:00Z' }))
    await act(async () => { root.render(<PortifyHistoryList feature="cns" onOpenPortify={vi.fn()} />) })
    expect(container.textContent).toContain('cns')
    expect(container.textContent).not.toContain('oms')
  })

  it('reopens a workflow on row click', async () => {
    workflows.push(entry({ workflowId: 'w1', feature: 'cns' }))
    const { onOpenPortify } = await render()
    await act(async () => rowFor('cns').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpenPortify).toHaveBeenCalledWith('w1')
  })

  it('lists the most-recent workflow first', async () => {
    workflows.push(entry({ workflowId: 'old', feature: 'older-feat', startedAt: '2026-06-01T10:00:00Z' }))
    workflows.push(entry({ workflowId: 'new', feature: 'newer-feat', startedAt: '2026-06-05T10:00:00Z' }))
    await render()
    const text = container.textContent ?? ''
    expect(text.indexOf('newer-feat')).toBeLessThan(text.indexOf('older-feat'))
  })

  it('removes a finished run from history (and does not open it)', async () => {
    workflows.push(entry({ workflowId: 'w1', feature: 'cns', status: 'saved' }))
    const { onOpenPortify } = await render()
    const removeBtn = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Remove cns'))
    expect(removeBtn).toBeTruthy()
    await act(async () => removeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(api.removePortify).toHaveBeenCalledWith('w1')
    expect(onOpenPortify).not.toHaveBeenCalled() // click didn't bubble to the row
  })

  it('does not offer remove for an active (in-flight) run', async () => {
    workflows.push(entry({ workflowId: 'w2', feature: 'oms', status: 'verifying', branch: 'b' }))
    await render()
    const removeBtn = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Remove'))
    expect(removeBtn).toBeUndefined()
  })
})
