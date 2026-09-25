import type { WorkspaceNotification, NotificationActionResult } from '@shared/notifications/types'
import { defaultOpts, request, type ClientOptions } from './internal'

export type { WorkspaceNotification, NotificationTarget } from '@shared/notifications/types'

export function resolveNotificationAction(id: string, opts?: ClientOptions): Promise<NotificationActionResult> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(`${baseUrl}/api/notifications/${encodeURIComponent(id)}/resolve-action`, { method: 'POST' }, fetchImpl)
}

export function getNotifications(opts?: ClientOptions): Promise<WorkspaceNotification[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(`${baseUrl}/api/notifications`, { method: 'GET' }, fetchImpl)
}

export function deleteNotification(id: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(`${baseUrl}/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl)
}

export function readNotification(id: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(`${baseUrl}/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }, fetchImpl)
}
