import { getRunServiceExcerpts, getRunServiceLogLines } from '@/shared/api/runs'
import type { ServiceLogExcerpts, ServiceLogLines } from '@shared/run-detail'
import { useLiveResource, type LiveResource } from '@/shared/state/use-live-resource'

/** One finished attempt's service spans. A span is fixed once its close marker
 *  lands, so the read happens once per attempt; `latest` re-keys it when a new
 *  execution starts, because that is when the live log moves into its
 *  segment and the old file stops holding it. */
export function useServiceExcerpts(
  runId: string, query: { execution: number; name: string; occurrence: number } | null, latest: number,
): LiveResource<ServiceLogExcerpts> {
  return useLiveResource(null, query ? JSON.stringify([runId, query.execution, query.name, query.occurrence, latest]) : null,
    async (key) => {
      const [, execution, name, occurrence] = JSON.parse(key) as [string, number, string, number]
      return getRunServiceExcerpts(runId, { execution, name, occurrence })
    }, { scope: runId })
}

/** A window of one service's retained log, for the anchored full-log view. */
export function useServiceLogLines(
  runId: string, service: string, execution: number, from: number, count: number,
): LiveResource<ServiceLogLines> {
  return useLiveResource(null, JSON.stringify([runId, service, execution, from, count]),
    async (key) => {
      const [, svc, exec, start, size] = JSON.parse(key) as [string, string, number, number, number]
      return getRunServiceLogLines(runId, svc, { execution: exec, from: start, count: size })
    }, { scope: runId })
}
