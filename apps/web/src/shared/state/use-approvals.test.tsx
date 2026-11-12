// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Approval } from '@shared/approval'
import { InvalidationProvider } from './invalidation'
import { useApprovals } from './use-approvals'

const api = vi.hoisted(() => ({ getApprovals: vi.fn(), answerApproval: vi.fn() }))
vi.mock('../api/approvals', () => api)

const answered: Approval = { id: 'one', command: 'start_run', feature: 'shop', reviewUrl: '/?dialog=notifications&approval=one', message: 'Coverage is stale.',
  status: 'answered', answer: { choice: 'Update coverage first' }, startedAt: '2026-10-06T00:00:00Z', expiresAt: '2026-10-06T00:30:00Z',
  schema: { properties: { choice: { type: 'string' } } } }
let container: HTMLDivElement; let root: Root
let resource!: ReturnType<typeof useApprovals>
function View() {
  resource = useApprovals()
  return <ul>{resource.items.map((item) => <li key={item.id}>{item.id}:{item.status}</li>)}</ul>
}
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks() })

it('shows an answer given before the first read lands, without waiting for that read', async () => {
  // The first read never settles, so the list is still unloaded (null) when the
  // answer comes back: the answered row must stand on its own, not be dropped.
  api.getApprovals.mockReturnValue(new Promise(() => {}))
  api.answerApproval.mockResolvedValue(answered)
  await act(async () => root.render(<InvalidationProvider><View /></InvalidationProvider>))
  expect(resource.items).toEqual([])
  await act(async () => resource.answer('one', { choice: 'Update coverage first' }))
  expect(api.answerApproval).toHaveBeenCalledExactlyOnceWith('one', { choice: 'Update coverage first' })
  expect(container.textContent).toBe('one:answered')
})
