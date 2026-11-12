// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Approval } from '@shared/approval'
import { InvalidationProvider, useInvalidation } from '../state/invalidation'
import { useApprovals } from '../state/use-approvals'
import { ApprovalNotices, isOpenApproval, PendingApprovalRow, SettledApprovalRow, UNDO_MS } from './ApprovalRows'
const api = vi.hoisted(() => ({ getApprovals: vi.fn(), answerApproval: vi.fn() }))
vi.mock('../api/approvals', () => api)
let container: HTMLDivElement; let root: Root; let rows: Approval[]
let invalidate!: ReturnType<typeof useInvalidation>['invalidate']
let resource!: ReturnType<typeof useApprovals>
const display = { title: 'Coverage out of date', choices: {
  'Update coverage first': { label: 'Update first', detail: "Doesn't start the run yet." },
  'Run now with stale coverage': { label: 'Run anyway' },
} }
const pending: Approval = { id: 'one', command: 'start_run', feature: 'shop', reviewUrl: '/?dialog=notifications&approval=one', message: 'Coverage is stale.',
  display, status: 'pending', startedAt: '2026-10-06T00:00:00Z', expiresAt: '2026-10-06T00:30:00Z',
  schema: { properties: { choice: { type: 'string', enum: ['Update coverage first', 'Run now with stale coverage'] } }, required: ['choice'] } }
let focus: string | null = 'one'
function View() {
  invalidate = useInvalidation().invalidate
  resource = useApprovals()
  return <><ApprovalNotices approvals={resource} focus={focus} /><ul>{resource.items.map((item) => isOpenApproval(item)
    ? <PendingApprovalRow key={item.id} item={item} focused={item.id === focus} confirmed={resource.confirmed} answer={resource.answer} />
    : <SettledApprovalRow key={item.id} item={item} focused={item.id === focus} />)}</ul></>
}
beforeEach(() => {
  vi.useFakeTimers(); rows = [pending]; focus = 'one'
  api.getApprovals.mockImplementation(async () => [...rows])
  api.answerApproval.mockImplementation(async (id, answer) => { rows = rows.map((r) => r.id === id ? { ...r, status: 'answered', answer } : r); return rows.find((r) => r.id === id) })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.clearAllMocks() })
async function mount() { await act(async () => root.render(<InvalidationProvider><View /></InvalidationProvider>)) }
const row = (id = 'one') => container.querySelector<HTMLElement>(`[data-testid="approval-${id}"]`)!
const button = (text: string, id = 'one') => [...row(id).querySelectorAll('button')].find((b) => b.textContent?.startsWith(text))!
const click = async (el: HTMLElement) => { await act(async () => { el.click() }) }

it('answers in one click after an undo window, then settles into a one-line receipt', async () => {
  rows.push({ ...pending, id: 'two' })
  await mount()
  expect(row().querySelector('h3')!.textContent).toBe('Coverage out of date')
  expect(row().querySelector('.sr-only')!.textContent).toBe('Coverage is stale.')
  expect(button('Update first').textContent).toBe("Update first. Doesn't start the run yet.")
  expect(row().className).toContain('bg-selected')
  expect(row('two').className).not.toContain('bg-selected')
  await click(button('Run anyway'))
  expect(row().querySelector('h3')!.textContent).toBe('Coverage out of date→: Run anyway')
  expect(button('Run anyway').parentElement!.className).toContain('invisible')
  expect(button('Undo').className).toContain('absolute')
  expect(api.answerApproval).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS) })
  expect(api.answerApproval).toHaveBeenCalledExactlyOnceWith('one', { choice: 'Run now with stale coverage' })
  expect(row().querySelector('h3')!.textContent).toBe('Coverage out of date→: Run anyway')
  expect(row().querySelector('button')).toBeNull()
  expect(button('Update first', 'two')).toBeTruthy()
})
it('takes an answer back inside the undo window without sending it', async () => {
  await mount()
  await click(button('Update first'))
  await click(button('Undo'))
  await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS) })
  expect(api.answerApproval).not.toHaveBeenCalled()
  expect(button('Update first')).toBeTruthy()
})
it('sends a held answer at once when the row goes away, and tolerates a refusal', async () => {
  await mount()
  await click(button('Update first'))
  api.answerApproval.mockRejectedValueOnce(new Error('already answered'))
  await act(async () => root.render(<InvalidationProvider><ul /></InvalidationProvider>))
  expect(api.answerApproval).toHaveBeenCalledExactlyOnceWith('one', { choice: 'Update coverage first' })
  await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS) })
  expect(api.answerApproval).toHaveBeenCalledTimes(1)
})
it('restores the choices and explains a rejected answer', async () => {
  await mount()
  api.answerApproval.mockRejectedValueOnce(new Error('The work changed.'))
  await click(button('Update first'))
  await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS) })
  expect(row().querySelector('[role=alert]')!.textContent).toContain('The work changed.')
  expect(button('Update first')).toBeTruthy()
})
it('shows an answer being applied without offering the choices again', async () => {
  rows = [{ ...pending, status: 'answering', answer: { choice: 'Update coverage first' } }]
  await mount()
  expect(row().querySelector('[role=status]')!.textContent).toBe('Applying…')
  expect(button('Update first').parentElement!.className).toContain('invisible')
})
it('resolves an already-open row from a chat answer without remounting', async () => {
  await mount()
  rows = [{ ...pending, status: 'answered', answer: { choice: 'Update coverage first' } }]
  await act(async () => { invalidate('approvals') })
  expect(row().querySelector('h3')!.textContent).toBe('Coverage out of date→: Update first')
})
it('recovers missed creation and resolution events within two seconds', async () => {
  rows = []; await mount()
  rows = [pending]
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(button('Run anyway')).toBeTruthy()
  rows = [{ ...pending, status: 'expired', error: 'Server restarted. Resume in chat.' }]
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(row().querySelector('h3')!.textContent).toBe('Coverage out of date→: Expired')
  expect(row().textContent).toContain('Server restarted')
  expect(row().querySelector('p.text-secondary:not(.sr-only)')).toBeTruthy()
})
it('shows connection failures and disables answering until authoritative reads recover', async () => {
  await mount()
  api.getApprovals.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { invalidate('approvals') })
  expect(container.textContent).toContain('Approvals unavailable: offline')
  expect(button('Update first').disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(button('Update first').disabled).toBe(false)
})
it('says when a linked approval no longer exists', async () => {
  focus = 'gone'; await mount()
  expect(container.textContent).toContain('This approval is unavailable.')
})
it('opens a form for an untitled question with several fields and submits every value', async () => {
  const schema: Approval['schema'] = { properties: {
    choice: { type: 'string', title: 'Decision', enum: ['save', 'revise'] },
    feedback: { type: 'string', description: 'Say what to change.' },
    count: { type: 'integer' },
    confirm: { type: 'boolean' },
  }, required: ['choice'] }
  rows = [{ ...pending, display: undefined, schema }]
  await mount()
  expect(row().querySelector('h3')!.textContent).toBe('Decision needed')
  expect(row().textContent).toContain('Coverage is stale.')
  await click(button('Answer'))
  expect(button('Close').getAttribute('aria-expanded')).toBe('true')
  expect([...row().querySelectorAll('legend')].map((l) => l.textContent)).toEqual(['Decision', 'Feedback', 'Count', 'Confirm'])
  expect(row().textContent).toContain('Say what to change.')
  await click(row().querySelectorAll<HTMLInputElement>('input[type=radio]')[1])
  expect(row().querySelectorAll('label')[1].className).toContain('border-accent')
  const [feedback, count] = row().querySelectorAll<HTMLInputElement>('input.cl-input')
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  await type(feedback, 'Use port 4000')
  await type(count, '3')
  await click(row().querySelector<HTMLInputElement>('input[type=checkbox]')!)
  await act(async () => { row().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(api.answerApproval).toHaveBeenCalledExactlyOnceWith('one', { choice: 'revise', feedback: 'Use port 4000', count: 3, confirm: true })
  expect(row().querySelector('h3')!.textContent).toBe('Decision recorded→: revise')
})
it('closes the form again and offers Answer for a single free-text field', async () => {
  rows = [{ ...pending, display: undefined, schema: { properties: { local_path: { type: 'string' } } } }]
  await mount()
  await click(button('Answer'))
  expect(row().querySelector('legend')!.textContent).toBe('Local path')
  await click(button('Close'))
  expect(row().querySelector('form')).toBeNull()
})
it('names how a settled question ended', async () => {
  rows = [
    { ...pending, id: 'failed', status: 'failed', error: 'Could not apply.' },
    { ...pending, id: 'text', display: undefined, status: 'answered', answer: { note: 'hi' }, schema: { properties: { note: { type: 'string' } } } },
    { ...pending, id: 'quiet', display: undefined, status: 'expired' },
    { ...pending, id: 'nofeature', feature: undefined, status: 'answered', answer: { choice: 'Run now with stale coverage' } },
  ]
  focus = null; await mount()
  expect(row('failed').querySelector('h3')!.textContent).toBe('Coverage out of date→: Failed')
  expect(row('failed').querySelector('p.text-danger')!.textContent).toBe('Could not apply.')
  expect(row('text').querySelector('h3')!.textContent).toBe('Decision recorded→: Answered')
  expect(row('quiet').querySelector('h3')!.textContent).toBe('Decision expired→: Expired')
  expect(row('nofeature').textContent).not.toContain('shop')
})
it('brings a linked row into view', async () => {
  const original = Element.prototype.scrollIntoView
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  await mount()
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
  Element.prototype.scrollIntoView = original
})
