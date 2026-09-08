// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceNotification } from '@/shared/api/notifications'

const api = vi.hoisted(() => ({ getNotifications: vi.fn(), addNotification: vi.fn(), deleteNotification: vi.fn(), readNotification: vi.fn() }))
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
  api.addNotification.mockImplementation(async (title, body) => { const note = { id: 'n2', title, body, createdAt: '2026-09-08T11:00:00Z' }; rows.push(note); return note })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!

it('opens the exact pending run, marks the notification read, and does not delete it on navigation', async () => {
  const navigate = vi.fn(), open = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={open} onNavigate={navigate} />))
  await act(async () => button('Review test changes →').click())
  expect(navigate).toHaveBeenCalledWith(target)
  expect(open).toHaveBeenCalledWith(false)
  expect(api.readNotification).toHaveBeenCalledWith('n1')
  expect(api.deleteNotification).not.toHaveBeenCalled()
})

it('deletes through the persistent API and removes the row only after success', async () => {
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={vi.fn()} />))
  api.deleteNotification.mockRejectedValueOnce(new Error('Disk is read-only'))
  await act(async () => button('Delete permanently').click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Disk is read-only')
  expect(document.querySelector('[data-testid="notification-n1"]')).not.toBeNull()
  await act(async () => button('Delete permanently').click())
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

it('adds notes through the same owner and ignores an older fetch arriving after a mutation', async () => {
  let state!: ReturnType<typeof useNotifications>
  function Probe() { state = useNotifications(); return null }
  let stale!: (rows: WorkspaceNotification[]) => void
  api.getNotifications.mockImplementationOnce(() => new Promise((resolve) => { stale = resolve }))
  await act(async () => root.render(<Probe />))
  await act(async () => { await state.add('Check service', 'Tomorrow') })
  expect(state.items.some((item) => item.title === 'Check service')).toBe(true)
  await act(async () => stale([]))
  expect(state.items.some((item) => item.title === 'Check service')).toBe(true)
})


it('opens the run instead of asking for another review after a notification resolves', async () => {
  rows = rows.map((row) => ({ ...row, resolvedAt: '2026-09-08T12:00:00Z' }))
  const navigate = vi.fn()
  await act(async () => root.render(<NotificationCenter open onOpenChange={vi.fn()} onNavigate={navigate} />))
  await act(async () => button('Open run →').click())
  expect(navigate).toHaveBeenCalledWith({ kind: 'run', feature: 'shop', runId: 'run-1' })
})
