import { describe, expect, it, vi } from 'vitest'
import { readNotificationUpdate } from './notification-catchup'
import type { CanaryLabMcpDeps } from './tool-schemas'

describe('notification catchup', () => {
  it('returns no update when the notification route is unavailable', async () => {
    await expect(readNotificationUpdate('demo', {} as CanaryLabMcpDeps)).resolves.toBeUndefined()
  })

  it('returns the feature projection from the notification route', async () => {
    const body = { feature: 'demo', state: 'ready' }
    const coverageRequest = vi.fn().mockResolvedValue({ statusCode: 200, body })
    await expect(readNotificationUpdate('a/b', { coverageRequest } as unknown as CanaryLabMcpDeps)).resolves.toEqual(body)
    expect(coverageRequest).toHaveBeenCalledWith({ method: 'GET', url: '/api/notifications/feature/a%2Fb' })
  })
})
