import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as configApi from '../api/config'
import * as internalApi from '../api/internal'
import type { FeatureSpecFile } from '../api/types'
import { useInvalidationKey } from './invalidation'
import { useLiveResource } from './use-live-resource'

export type TestLoadFailure = { kind: 'discovery' | 'config' | 'removed' | 'request'; message: string }
type Observation = { specs?: FeatureSpecFile[]; failure?: TestLoadFailure; requestError?: string; attempt: number }

/** Roster reads share ordering and local retention. The visible Tests column
 * also reconciles healthy workspace source when a file event is missed. */
export function useFeatureTestRoster({ feature, runId, enabled = true, refreshKey, recover = false }: {
  feature: string | null
  runId?: string
  enabled?: boolean
  refreshKey?: string | number
  recover?: boolean
}) {
  const version = useInvalidationKey('tests')
  const key = enabled && feature ? JSON.stringify([feature, runId ?? null]) : null
  // This counts attempts in a burst, not request ownership. The shared reader
  // alone decides which response may be accepted after refresh or replacement.
  const burst = useMemo(() => ({ attempts: 0 }), [key, version, refreshKey])
  const retained = useRef(new Map<string, FeatureSpecFile[]>())
  const resource = useLiveResource<Observation>('tests', key, async () => {
    const attempt = ++burst.attempts
    try {
      const specs = await (runId || recover ? configApi.getFeatureTests(feature!, undefined, runId) : configApi.getFeatureTests(feature!))
      const diagnostic = specs.find((spec) => spec.discoveryError)?.discoveryError
      if (!diagnostic) burst.attempts = 0
      return { specs, attempt, failure: diagnostic ? { kind: 'discovery', message: diagnostic } : undefined }
    } catch (error) {
      return { attempt, failure: classifyLoadError(error), requestError: error instanceof Error ? error.message : 'Failed to load test source' }
    }
  }, { retainOnError: true, refreshKey,
    retryDelayMs: (next) => recover && next?.failure && next.failure.kind !== 'removed' && next.attempt < 3 ? 1000 : undefined,
    // Suites created after startup may have no dirty-spec watcher yet. Reuse
    // the shared reader's ordered polling; historical snapshots stay immutable.
    pollWhile: (next) => recover && !runId && !!next?.specs && !next.failure,
    pollIntervalMs: 5000,
    pauseWhenHidden: true,
  })
  const observation = resource.value
  const failure = observation?.failure ?? null
  useEffect(() => {
    if (!key || !observation) return
    if (observation.failure?.kind === 'removed') retained.current.delete(key)
    else if (observation.specs && !observation.failure) retained.current.set(key, observation.specs)
  }, [key, observation])
  const recoveryKind = failure?.kind
  const recoveryMessage = failure?.message
  useEffect(() => {
    if (!recover || !key || runId || (recoveryKind !== 'removed' && recoveryKind !== 'config')) return
    const timer = setInterval(resource.refresh, 10_000)
    return () => clearInterval(timer)
  }, [recover, key, runId, recoveryKind, recoveryMessage, resource.refresh])
  const refresh = useCallback(() => { burst.attempts = 0; resource.refresh() }, [burst, resource.refresh])
  const specs = key && failure?.kind !== 'removed'
    ? observation?.specs && !failure ? observation.specs : retained.current.get(key) ?? null
    : null
  return {
    specs,
    // Coverage still interprets partial/parse-error source rows itself.
    source: observation?.specs ?? specs,
    incomplete: observation?.specs && failure?.kind === 'discovery' ? observation.specs : [],
    failure,
    error: observation?.requestError ?? null,
    loading: resource.loading,
    confirmed: resource.confirmed && !failure,
    refresh,
  }
}

function formatLoadError(err: unknown): string {
  if (err instanceof internalApi.ApiError) {
    const context = `Unable to load tests for this suite. Server returned HTTP ${err.status}.`
    if (err.body && typeof err.body === 'object') {
      const body = err.body as { message?: unknown; error?: unknown }
      const message = typeof body.message === 'string' ? body.message : body.error
      if (typeof message === 'string') return `${context} ${message}`
    }
    return context
  }
  return 'Unable to load tests for this suite.'
}

function classifyLoadError(err: unknown): TestLoadFailure {
  const body = err instanceof internalApi.ApiError && err.body && typeof err.body === 'object'
    ? err.body as { code?: unknown; error?: unknown } : undefined
  const code = body?.code
  return {
    kind: code === 'suite-removed' ? 'removed' : code === 'discovery-failed' ? 'config' : 'request',
    message: (code === 'suite-removed' || code === 'discovery-failed') && typeof body?.error === 'string'
      ? body.error : formatLoadError(err),
  }
}
