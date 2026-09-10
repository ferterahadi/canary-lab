import { describe, it, expect, vi } from 'vitest'
import { getNotifications, deleteNotification, readNotification } from './notifications'
import { ok, fail } from './__fixtures__/response'

describe('notifications api', () => {
  it('getNotifications returns the inbox as sent', async () => {
    const inbox = [{ id: 'n1', title: 'shop paused', body: 'Run stage failed.', createdAt: 't', severity: 'warning', target: { kind: 'flight', flightId: 'f1' } }]
    const fetchImpl = vi.fn().mockResolvedValue(ok(inbox))
    await expect(getNotifications({ baseUrl: 'http://x', fetchImpl })).resolves.toEqual(inbox)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/notifications', { method: 'GET' })
  })

  it('getNotifications throws rather than reporting an empty inbox when the server fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'inbox unreadable' }))
    await expect(getNotifications({ fetchImpl })).rejects.toMatchObject({ status: 500, message: 'inbox unreadable' })
  })

  it('deleteNotification and readNotification address one message by encoded id', async () => {
    // The id is a store key (`flight:f1`, `run:r 1`), so it has to survive the
    // path: an unencoded `/` or space would address a different route.
    const fetchImpl = vi.fn(async () => ok(''))
    await deleteNotification('flight:f/1', { baseUrl: 'http://x', fetchImpl })
    await readNotification('run:r 1', { fetchImpl })
    expect(fetchImpl.mock.calls).toEqual([
      ['http://x/api/notifications/flight%3Af%2F1', { method: 'DELETE' }],
      ['/api/notifications/run%3Ar%201/read', { method: 'POST' }],
    ])
  })
})
