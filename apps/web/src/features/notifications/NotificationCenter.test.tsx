// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceNotification } from '@/shared/api/notifications'

const api = vi.hoisted(() => ({ getNotifications: vi.fn(), deleteNotification: vi.fn(), readNotification: vi.fn() }))
vi.mock('@/shared/api/notifications', () => api)
import { NotificationCenter } from './NotificationCenter'
import { useNotifications } from './use-notifications'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'

let container: HTMLDivElement
let root: Root
let rows: WorkspaceNotification[]
const target = { kind: 'test-review' as const, feature: 'shop', runId: 'run-1' }
beforeEach(() => {
  vi.clearAllMocks()
  rows = [{ id: 'n1', title: 'shop awaits review', body: '1 changed file', target, toast: true, createdAt: '2026-09-08T10:00:00Z' }]
  api.getNotifications.mockImplementation(async () => [...rows])
  api.deleteNotification.mockImplementation(async (id) => { rows = rows.filter((row) => row.id !== id) })
  api.readNotification.mockImplementation(async (id) => { rows = rows.map((row) => row.id === id ? { ...row, readAt: 'now' } : row) })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!
const labelled = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!

it('keeps a test review and Flight blocker separate in an already-open inbox', async () => {
  const flight = { kind: 'flight' as const, flightId: 'f1' }
  const navigate = vi.fn()
  let invalidate!: ReturnType<typeof useInvalidation>['invalidate']
  function View() {
    invalidate = useInvalidation().invalidate
    return <NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />
  }
  await act(async () => root.render(<InvalidationProvider><View /></InvalidationProvider>))
  rows.push({ id: 'flight', title: 'shop: Test run failed', body: 'Open Flight to recover and continue.', severity: 'warning', target: flight, toast: true, createdAt: '2026-09-08T10:00:00Z' })
  await act(async () => { invalidate('notifications') })
  expect(labelled('Notifications, 2 need attention')).not.toBeNull()
  await act(async () => labelled('Review test changes').click())
  expect(navigate).toHaveBeenLastCalledWith(target)
  await act(async () => labelled('Open flight').click())
  expect(navigate).toHaveBeenLastCalledWith(flight)
  rows = rows.map((row) => row.id === 'flight' ? { ...row, resolvedAt: 'now' } : row)
  await act(async () => { invalidate('notifications') })
  expect(labelled('Notifications, 1 need attention')).not.toBeNull()
  expect(labelled('Review test changes')).not.toBeNull()
  expect(labelled('Open flight')).toBeNull()
})

it.each([
  { kind: 'coverage' as const, feature: 'shop', stage: 'specs-coverage' as const, label: 'Open flight' },
  { kind: 'run' as const, feature: 'shop', runId: 'r1', label: 'Open run' },
])('labels the $kind notification with its real destination', async ({ label, ...destination }) => {
  rows = [{ ...rows[0], target: destination, severity: 'warning' }]
  const navigate = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />))
  await act(async () => labelled(label).click())
  expect(navigate).toHaveBeenCalledExactlyOnceWith(destination)
  expect(api.deleteNotification).not.toHaveBeenCalled()
})

it('opens the blocked Flight without trying to resolve it from the notification', async () => {
  const flight = { kind: 'flight' as const, flightId: 'fl-shop' }
  rows = [{ ...rows[0], title: 'shop: Test run failed', body: 'Open Flight to recover and continue.', severity: 'warning', target: flight }]
  const navigate = vi.fn()
  const close = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={close} onNavigate={navigate} />))
  await act(async () => labelled('Open flight').click())
  expect(navigate).toHaveBeenCalledExactlyOnceWith(flight)
  expect(close).toHaveBeenCalledWith(false)
  expect(api.readNotification).toHaveBeenCalledWith('n1')
  expect(api.deleteNotification).not.toHaveBeenCalled()
})

it('counts only actionable messages and keeps resolved rows in history', async () => {
  rows = [
    { ...rows[0], id: 'resolved-unread', resolvedAt: 'now' },
    { ...rows[0], id: 'resolved-read', resolvedAt: 'now', readAt: 'now' },
    { ...rows[0], id: 'active-read', readAt: 'now' },
    { ...rows[0], id: 'active-unread' },
  ]
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  expect(labelled('Notifications, 2 need attention')).not.toBeNull()
  expect(button('Needs attention 2')).toBeDefined()
  expect(button('History 2')).toBeDefined()
  expect(document.querySelector('[data-testid="notification-active-read"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="notification-active-unread"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="notification-resolved-unread"]')).toBeNull()
  expect(document.querySelector('[data-testid="notification-resolved-read"]')).toBeNull()
  expect(api.readNotification).not.toHaveBeenCalled()
  await act(async () => labelled('Mark read').click())
  expect(labelled('Notifications, 2 need attention')).not.toBeNull()
  expect(document.querySelector('[data-testid="notification-active-unread"]')).not.toBeNull()
  await act(async () => button('History 2').click())
  expect(document.querySelector('[data-testid="notification-resolved-unread"]')?.textContent).toContain('Unread')
  expect(document.querySelector('[data-testid="notification-resolved-read"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="notification-active-unread"]')).toBeNull()
  expect(document.querySelector('[data-testid="notification-active-read"]')).toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="notification-resolved-unread"] [aria-label="Mark read"]')!.click())
  expect(labelled('Notifications, 2 need attention')).not.toBeNull()
  expect(document.querySelector('[data-testid="notification-resolved-unread"]')?.textContent).toContain('Resolved')
  expect(document.querySelector('[data-testid="notification-resolved-unread"]')?.textContent).not.toContain('Unread')
})

it('keeps resolved unread alerts out of the attention count', async () => {
  rows = [{ ...rows[0], resolvedAt: 'now', severity: 'danger' }]
  await act(async () => root.render(<NotificationCenter open={false} onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  expect(labelled('Notifications, 0 need attention')).not.toBeNull()
  expect(button('Review test changes')).toBeUndefined()
})

it.each(['neutral', 'warning', undefined] as const)('keeps unresolved test reviews amber with a visible action, including %s messages', async (severity) => {
  rows = [{ ...rows[0], severity }]
  const navigate = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />))
  const row = () => document.querySelector('[data-testid="notification-n1"]')!
  expect(row().querySelector('.cl-status-dot')?.className).toContain('bg-warning')
  expect(row().textContent).toContain('Review needed')
  // The chevron is the shared SVG the rest of the app's "go there" controls
  // use, so the button's text is the word and the arrow is a mark beside it.
  expect(labelled('Review test changes').textContent).toBe('Review')
  expect(labelled('Review test changes').querySelector('svg')).toBeTruthy()
  await act(async () => labelled('Mark read').click())
  expect(row().querySelector('.cl-status-dot')?.className).toContain('bg-warning')
  expect(row().textContent).toContain('Review needed')
  expect(row().textContent).not.toContain('Unread')
  expect(navigate).not.toHaveBeenCalled()
  await act(async () => labelled('Review test changes').click())
  expect(navigate).toHaveBeenCalledWith(target)
})

it('keeps neutral notes and resolved reviews grey instead of implying unfinished work', async () => {
  rows = [
    { ...rows[0], id: 'note', target: undefined, severity: 'neutral' },
    { ...rows[0], id: 'resolved', resolvedAt: 'now', severity: 'warning' },
  ]
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  await act(async () => button('History 2').click())
  for (const id of ['note', 'resolved']) {
    expect(document.querySelector(`[data-testid="notification-${id}"] .cl-status-dot`)?.className).toContain('bg-idle')
  }
  expect(document.body.textContent).not.toContain('Review needed')
  expect(labelled('Review test changes')).toBeNull()
})

it('opens the exact pending run, marks the notification read, and does not delete it on navigation', async () => {
  const navigate = vi.fn()
  const open = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={open} onNavigate={navigate} />))
  await act(async () => labelled('Review test changes').click())
  expect(navigate).toHaveBeenCalledWith(target)
  expect(open).toHaveBeenCalledWith(false)
  expect(api.readNotification).toHaveBeenCalledWith('n1')
  expect(api.deleteNotification).not.toHaveBeenCalled()
})

it('deletes through the persistent API and removes the row only after success', async () => {
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  api.deleteNotification.mockRejectedValueOnce(new Error('Disk is read-only'))
  await act(async () => labelled('Delete permanently').click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Disk is read-only')
  expect(document.querySelector('[data-testid="notification-n1"]')).not.toBeNull()
  await act(async () => labelled('Delete permanently').click())
  expect(document.querySelector('[data-testid="notification-n1"]')).toBeNull()
  expect(document.body.textContent).toContain('Nothing needs attention')
})

it('shows a retryable loading failure rather than an empty inbox', async () => {
  api.getNotifications.mockRejectedValueOnce(new Error('Inbox unavailable'))
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  expect(document.body.textContent).toContain('Inbox unavailable')
  expect(document.body.textContent).not.toContain('No notifications')
  await act(async () => button('Retry').click())
  expect(document.querySelector('[data-testid="notification-n1"]')).not.toBeNull()
})

it('does not mirror an inbox notification into a bottom-right toast', async () => {
  await act(async () => root.render(<NotificationCenter open={false} onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  expect(labelled('Notifications, 1 need attention')).not.toBeNull()
  expect(document.querySelector('[data-testid="toast-host"]')).toBeNull()
  expect(api.deleteNotification).not.toHaveBeenCalled()
})

it('keeps an advisory item in the attention inbox', async () => {
  rows = [{ ...rows[0], title: 'shop: possible test weakening', severity: 'danger', toast: false }]
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  expect(labelled('Notifications, 1 need attention')).not.toBeNull()
  expect(document.querySelector('[data-testid="notification-n1"]')).not.toBeNull()
  expect(labelled('Review test changes')).not.toBeNull()
})

it('ignores an older fetch arriving after a read mutation', async () => {
  let state!: ReturnType<typeof useNotifications>
  function Probe() { state = useNotifications(); return null }
  let stale!: (rows: WorkspaceNotification[]) => void
  api.getNotifications.mockImplementationOnce(() => new Promise((resolve) => { stale = resolve }))
  await act(async () => root.render(<Probe />))
  await act(async () => { await state.read('n1') })
  expect(state.items[0].readAt).toBe('now')
  await act(async () => stale([]))
  expect(state.items[0].readAt).toBe('now')
})

it('reconciles notifications after a dropped workspace event', async () => {
  vi.useFakeTimers()
  function Probe() { useNotifications(); return null }
  try {
    await act(async () => root.render(<Probe />))
    expect(api.getNotifications).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.getNotifications).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})


it('opens the run instead of asking for another review after a notification resolves', async () => {
  rows = rows.map((row) => ({ ...row, resolvedAt: '2026-09-08T12:00:00Z' }))
  const navigate = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />))
  await act(async () => button('History 1').click())
  await act(async () => labelled('Open run').click())
  expect(navigate).toHaveBeenCalledWith({ kind: 'run', feature: 'shop', runId: 'run-1' })
})

it('has no manual note creation and opens a feature-level weakening hint without inventing a run', async () => {
  rows = [{ id: 'weak', title: 'shop: tests may have been weakened', body: 'A hint, not a verdict.', target: { kind: 'test-review', feature: 'shop' }, severity: 'danger', toast: false, createdAt: '2026-09-09T10:00:00Z' }]
  const navigate = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />))
  expect([...document.querySelectorAll('button')].some((element) => /\+ Add/.test(element.textContent ?? ''))).toBe(false)
  expect(document.querySelector('form')).toBeNull()
  expect(document.body.textContent).toContain('Test integrity · Hint')
  await act(async () => labelled('Review test changes').click())
  expect(navigate).toHaveBeenCalledWith({ kind: 'test-review', feature: 'shop' })
})

it('orders weakening hints before ordinary attention without accenting an arrow', async () => {
  rows.push({ id: 'weak', title: 'Possible weakening', body: 'Review', severity: 'danger', target: { kind: 'test-review', feature: 'shop' }, createdAt: '2026-09-07T10:00:00Z' })
  rows.push({ id: 'done', title: 'Resolved', body: '', target, resolvedAt: 'now', createdAt: '2026-09-09T10:00:00Z' })
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  expect([...document.querySelectorAll('[data-testid^="notification-"]')].map((element) => element.getAttribute('data-testid'))).toEqual(['notification-center', 'notification-weak', 'notification-n1'])
  expect(document.querySelector('[data-testid="notification-weak"] [aria-label="Review test changes"]')?.className).toContain('cl-button')
  expect(document.querySelector('[data-testid="notification-weak"] [aria-label="Review test changes"]')?.className).not.toContain('cl-button-primary')
  expect(document.querySelector('[data-testid="notification-n1"] [aria-label="Review test changes"]')?.className).not.toContain('cl-button-primary')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="notification-weak"] [aria-label="Mark read"]')!.click())
  expect(document.querySelector('[data-testid="notification-weak"]')).not.toBeNull()
  await act(async () => button('History 1').click())
  expect(document.querySelector('[data-testid="notification-done"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="notification-n1"]')).toBeNull()
})

it('opens a resolved feature-only alert as the suite, not an active review', async () => {
  rows = [{ id: 'resolved', title: 'Tests changed', body: '', target: { kind: 'test-review', feature: 'shop' }, resolvedAt: 'now', createdAt: '2026-09-09T10:00:00Z' }]
  const navigate = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />))
  await act(async () => button('History 1').click())
  await act(async () => labelled('Open suite').click())
  expect(navigate).toHaveBeenCalledWith({ kind: 'feature', feature: 'shop' })
})
