// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceNotification } from '@/shared/api/notifications'

const api = vi.hoisted(() => ({ getNotifications: vi.fn(), deleteNotification: vi.fn(), readNotification: vi.fn() }))
vi.mock('@/shared/api/notifications', () => api)
import { NotificationCenter } from './NotificationCenter'
import { useNotifications } from './use-notifications'

let container: HTMLDivElement
let root: Root
let rows: WorkspaceNotification[]
const target = { kind: 'test-review' as const, feature: 'shop', runId: 'run-1' }
beforeEach(() => {
  vi.clearAllMocks()
  rows = [{ id: 'n1', title: 'shop awaits review', body: '1 changed file', target, createdAt: '2026-09-08T10:00:00Z' }]
  api.getNotifications.mockImplementation(async () => [...rows])
  api.deleteNotification.mockImplementation(async (id) => { rows = rows.filter((row) => row.id !== id) })
  api.readNotification.mockImplementation(async (id) => { rows = rows.map((row) => row.id === id ? { ...row, readAt: 'now' } : row) })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!
const labelled = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
// Resolved messages sit behind a collapsed group, so a test about one has to
// open it the way a reader would.
const openResolved = async () => act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Resolved'))!.click())

it('opens the exact pending run, marks the notification read, and does not delete it on navigation', async () => {
  const navigate = vi.fn(), open = vi.fn()
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
  expect(document.body.textContent).toContain('No notifications')
})

it('shows a retryable loading failure rather than an empty inbox', async () => {
  api.getNotifications.mockRejectedValueOnce(new Error('Inbox unavailable'))
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  expect(document.body.textContent).toContain('Inbox unavailable')
  expect(document.body.textContent).not.toContain('No notifications')
  await act(async () => button('Retry').click())
  expect(document.querySelector('[data-testid="notification-n1"]')).not.toBeNull()
})

it('opens a toast without deleting its message; the close button permanently deletes it', async () => {
  const open = vi.fn()
  await act(async () => root.render(<NotificationCenter open={false} onOpenChange={open} onNavigate={vi.fn()} />))
  await act(async () => button('Open notifications').click())
  expect(open).toHaveBeenCalledWith(true)
  expect(api.deleteNotification).not.toHaveBeenCalled()
  rows = rows.map(({ readAt: _readAt, ...row }) => row)
  act(() => root.unmount()); root = createRoot(container)
  await act(async () => root.render(<NotificationCenter open={false} onOpenChange={open} onNavigate={vi.fn()} />))
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Delete notification permanently"]')!.click())
  expect(api.deleteNotification).toHaveBeenCalledWith('n1')
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


it('opens the run instead of asking for another review after a notification resolves', async () => {
  rows = rows.map((row) => ({ ...row, resolvedAt: '2026-09-08T12:00:00Z' }))
  const navigate = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />))
  await openResolved()
  await act(async () => labelled('Open run').click())
  expect(navigate).toHaveBeenCalledWith({ kind: 'run', feature: 'shop', runId: 'run-1' })
})

it('has no manual note creation and opens a feature-level weakening hint without inventing a run', async () => {
  rows = [{ id: 'weak', title: 'shop: tests may have been weakened', body: 'A hint, not a verdict.', target: { kind: 'test-review', feature: 'shop' }, severity: 'danger', createdAt: '2026-09-09T10:00:00Z' }]
  const navigate = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />))
  expect([...document.querySelectorAll('button')].some((element) => /\+ Add/.test(element.textContent ?? ''))).toBe(false)
  expect(document.querySelector('form')).toBeNull()
  expect(document.body.textContent).toContain('Test integrity · Hint')
  await act(async () => labelled('Review test changes').click())
  expect(navigate).toHaveBeenCalledWith({ kind: 'test-review', feature: 'shop' })
})

it('orders weakening hints before ordinary attention and filters read and resolved items', async () => {
  rows.push({ id: 'weak', title: 'Possible weakening', body: 'Review', severity: 'danger', target: { kind: 'test-review', feature: 'shop' }, createdAt: '2026-09-07T10:00:00Z' })
  rows.push({ id: 'done', title: 'Resolved', body: '', target, resolvedAt: 'now', createdAt: '2026-09-09T10:00:00Z' })
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  await openResolved()
  expect([...document.querySelectorAll('[data-testid^="notification-"]')].map((element) => element.getAttribute('data-testid'))).toEqual(['notification-center', 'notification-weak', 'notification-n1', 'notification-done'])
  // Only the row to act on first carries the filled accent; the rest stay ghost
  // buttons, so the fill reads as "start here" rather than "this is a button".
  expect(document.querySelector('[data-testid="notification-weak"] [aria-label="Review test changes"]')?.className).toContain('cl-button-primary')
  expect(document.querySelector('[data-testid="notification-n1"] [aria-label="Review test changes"]')?.className).not.toContain('cl-button-primary')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="notification-weak"] [aria-label="Mark read"]')!.click())
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Notification filter"] button')][1].click())
  expect(document.querySelector('[data-testid="notification-weak"]')).toBeNull()
  expect(document.querySelector('[data-testid="notification-done"]')).toBeNull()
  expect(document.querySelector('[data-testid="notification-n1"]')).not.toBeNull()
})

it('opens a resolved feature-only alert as the suite, not an active review', async () => {
  rows = [{ id: 'resolved', title: 'Tests changed', body: '', target: { kind: 'test-review', feature: 'shop' }, resolvedAt: 'now', createdAt: '2026-09-09T10:00:00Z' }]
  const navigate = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />))
  await openResolved()
  await act(async () => labelled('Open suite').click())
  expect(navigate).toHaveBeenCalledWith({ kind: 'feature', feature: 'shop' })
})
