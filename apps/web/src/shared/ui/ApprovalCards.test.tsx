// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Approval } from '@shared/approval'
import { InvalidationProvider, useInvalidation } from '../state/invalidation'
import { useApprovals } from '../state/use-approvals'
import { ApprovalCards } from './ApprovalCards'
const api = vi.hoisted(() => ({ getApprovals: vi.fn(), answerApproval: vi.fn() }))
vi.mock('../api/approvals', () => api)
let container: HTMLDivElement; let root: Root; let rows: Approval[]
let invalidate!: ReturnType<typeof useInvalidation>['invalidate']
let resource!: ReturnType<typeof useApprovals>
const pending: Approval = { id: 'one', command: 'start_run', feature: 'shop', reviewUrl: '/?dialog=notifications&approval=one', message: 'Coverage is stale.',
  status: 'pending', startedAt: '2026-10-06T00:00:00Z', expiresAt: '2026-10-06T00:30:00Z',
  schema: { properties: { choice: { type: 'string', enum: ['Update coverage first', 'Run now with stale coverage'] } }, required: ['choice'] } }
function View() {
  invalidate = useInvalidation().invalidate
  resource = useApprovals()
  return <ApprovalCards approvals={resource} focus="one" />
}
beforeEach(() => {
  vi.useFakeTimers(); rows = [pending]
  api.getApprovals.mockImplementation(async () => [...rows])
  api.answerApproval.mockImplementation(async (id, answer) => { rows = rows.map((r) => r.id === id ? { ...r, status: 'answered', answer } : r); return rows[0] })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.clearAllMocks() })
async function mount() { await act(async () => root.render(<InvalidationProvider><View /></InvalidationProvider>)) }
it('shows the real choices and updates both the form and receipt after a browser answer', async () => {
  rows.push({ ...pending, id: 'two' })
  await mount()
  expect(container.textContent).toContain('Update coverage first')
  expect(container.textContent).toContain('Run now with stale coverage')
  const radio = container.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]
  await act(async () => { radio.click() })
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(api.answerApproval).toHaveBeenCalledExactlyOnceWith('one', { choice: 'Run now with stale coverage' })
  expect(container.textContent).toContain('Answered: Run now with stale coverage')
  expect(container.querySelector('[data-testid="approval-one"] form')).toBeNull()
  expect(container.querySelector('[data-testid="approval-two"] form')).not.toBeNull()
})
it('keeps an authoritative answer when it arrives before a slow list snapshot', async () => {
  let resolve!: (value: Approval[]) => void
  api.getApprovals.mockImplementationOnce(() => new Promise<Approval[]>((done) => { resolve = done }))
  await mount()
  await act(async () => { await resource.answer('one', { choice: 'Update coverage first' }) })
  await act(async () => { resolve([pending]) })
  expect(container.textContent).toContain('Answered: Update coverage first')
  expect(container.querySelector('form')).toBeNull()
  expect(api.getApprovals.mock.calls[0][0].readRevision).not.toBe(api.getApprovals.mock.lastCall![0].readRevision)
})
it('resolves an already-open form from a chat answer without remounting', async () => {
  await mount()
  rows = [{ ...pending, status: 'answered', answer: { choice: 'Update coverage first' } }]
  await act(async () => { invalidate('approvals') })
  expect(container.textContent).toContain('Answered: Update coverage first')
  expect(container.querySelector('form')).toBeNull()
})
it('recovers missed creation and resolution events within two seconds', async () => {
  rows = []; await mount()
  rows = [pending]
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(container.textContent).toContain('Run now with stale coverage')
  rows = [{ ...pending, status: 'expired', error: 'Server restarted. Resume in chat.' }]
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(container.textContent).toContain('Server restarted')
  expect(container.querySelector('form')).toBeNull()
})
it('shows connection failures and disables approval until authoritative reads recover', async () => {
  await mount()
  api.getApprovals.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { invalidate('approvals') })
  expect(container.textContent).toContain('offline')
  expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
})
