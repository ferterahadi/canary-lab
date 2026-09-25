import type { CanaryLabMcpDeps } from './tool-schemas'

/** Same projection as the browser; a tool response is the supported delivery
 * path for clients that cannot put unsolicited notifications into model context. */
export async function readNotificationUpdate(feature: string, deps: CanaryLabMcpDeps): Promise<unknown> {
  if (!deps.coverageRequest) return undefined
  try {
    const response = await deps.coverageRequest({ method: 'GET', url: `/api/notifications/feature/${encodeURIComponent(feature)}` })
    return response.statusCode < 400 ? response.body : { feature, state: 'unavailable', reason: 'Cannot confirm notification actions.' }
  } catch (error) {
    return { feature, state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}
