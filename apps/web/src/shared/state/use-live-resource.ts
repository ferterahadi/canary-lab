import { useCallback, useEffect, useRef, useState } from 'react'
import { useInvalidationKey } from './invalidation'
import type { InvalidationTopic } from './invalidation-bus'

// One call that fetches a remote value AND keeps it live.
//
// The defect this exists to prevent: a leaf writes the obvious effect —
//
//     useEffect(() => { api.getX(id).then(setX) }, [id])
//
// — and it is correct at that instant and wrong a second later. The Parallel
// readiness stage was exactly this: it fetched the portify workflow keyed on
// an id pinned at stage START, so it resolved once, empty, and never again.
// Both evidence cards stayed blank until the user reloaded the page, and the
// server had been pushing the finished record the whole time.
//
// Nothing about that effect looks wrong in review, which is why the fix is a
// shape rather than a rule: here the topic that refreshes the value is a
// REQUIRED argument, so a fetch with no live trigger is not something you can
// write by accident. The topic is bumped by the workspace-event handler
// (use-workspace-data.ts) when the server says that surface changed.
//
// This is the read-side half of the same idea the server applies to writes: the
// owner of the state announces, and every consumer hangs off that announcement
// (see apps/web-server/src/shared/store-event-bridge.ts).
//
// When the value is pushed to the client in full — the portify manifest, run
// records, evaluation tasks — read the feature's own WS store instead; a live
// store beats refetching on a nudge. This hook is for values that only REST
// can answer.

export interface LiveResource<T> {
  /** The last resolved value; `null` before the first resolve, when `key` is
   *  null, or when the fetch failed. A failure reads the same as absent, which
   *  is what ordinary reads render. Polling tasks retain their last snapshot
   *  through failed reads so a network error cannot erase a running task. */
  value: T | null
  /** True while a fetch is in flight, including refetches. Lets a caller hold a
   *  skeleton in place instead of flashing an empty state mid-refresh. */
  loading: boolean
  error: string | null
  /** A current successful read, not a remount cache or an expired lease. */
  confirmed: boolean
  refresh: () => void
}

/**
 * Fetch `key`'s value and refetch it whenever `topic` (optionally scoped) is
 * invalidated.
 *
 * `key` identifies the resource — a feature name, a run id — and doubles as the
 * gate: pass `null` when there is nothing to fetch yet and the hook stays idle
 * rather than firing a request for `undefined`. The fetcher itself may be an
 * inline arrow; it is read through a ref, so a new closure each render does not
 * re-trigger anything.
 */
// Last resolved value per (cache tag, key) — module-level so a REMOUNT paints
// stale-then-fresh instead of skeleton-then-fresh. The flight rail remounts its
// stage pane on every row click (`key={stage.key}`), and without this every
// revisit to an already-read stage re-showed placeholders while the same ledger
// / docs listing / config was fetched again. Only seeds the first paint; the
// fetch still runs and replaces it, and an invalidation still refetches.
// Unbounded on purpose: entries are small (parsed JSON the pane already held)
// and the key space is the workspace's features/runs, not user input.
const lastResolved = new Map<string, unknown>()

export function useLiveResource<T>(
  topic: InvalidationTopic,
  key: string | null,
  fetcher: (key: string, opts?: { readRevision: string }) => Promise<T | null>,
  opts: {
    scope?: string
    /** Opt IN to the stale-then-fresh remount cache with a tag naming WHAT is
     *  fetched (e.g. `'ledger'`). Explicit because the topic alone cannot key
     *  it: two resources legitimately share a topic and a key (the ledger and
     *  the docs listing both live on `coverage` + the feature name), and an
     *  inferred key would hand one resource the other's value. Omit for a
     *  resource that must never paint stale. */
    cache?: string
    /** Reconcile an active task when a workspace event is missed. Failed reads
     *  retain the last snapshot and retry; terminal values stop the reads. */
    pollWhile?: (value: T | null) => boolean
    /** Event delivery is not durable. Accuracy-sensitive reads reconcile even
     * when settled, and stop certifying old values when the read lease expires. */
    reconcileMs?: number
    leaseMs?: number
    refreshKey?: string | number
  } = {},
): LiveResource<T> {
  const cacheKey = opts.cache !== undefined && key !== null ? `${opts.cache}:${key}` : null
  const [value, setValue] = useState<T | null>(() => (
    cacheKey !== null ? (lastResolved.get(cacheKey) as T | undefined) ?? null : null
  ))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), [])
  const version = useInvalidationKey(topic, opts.scope)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const cacheTag = opts.cache
  const pollWhileRef = useRef(opts.pollWhile)
  pollWhileRef.current = opts.pollWhile
  const polling = opts.pollWhile !== undefined || opts.reconcileMs !== undefined
  const { reconcileMs, leaseMs, refreshKey } = opts
  const readKey = JSON.stringify([key, version, refreshKey, refreshVersion])
  const [confirmedReadKey, setConfirmedReadKey] = useState<string | null>(null)
  const [valueKey, setValueKey] = useState(key)
  const retained = useRef<{ key: string; value: T | null } | null>(null)

  useEffect(() => {
    setValueKey(key)
    if (key === null) {
      setValue(null)
      setLoading(false)
      setConfirmed(false)
      setError(null)
      return
    }
    let alive = true
    // A key CHANGE (not a remount) paints the new key's cached value — or
    // nothing — immediately, so the pane never shows one stage's figures under
    // another stage's labels while the fetch is in flight.
    let current = reconcileMs && retained.current?.key === key ? retained.current.value
      : cacheTag !== undefined ? (lastResolved.get(`${cacheTag}:${key}`) as T | undefined) ?? null : null
    setValue(current)
    setLoading(true)
    setConfirmed(false)
    setError(null)
    let requested = 0
    let lease: ReturnType<typeof setTimeout> | undefined
    const fetch = (event?: Event) => {
      const request = ++requested
      // Join sibling readers, never a previous reconciliation round or a read
      // started before reconnect/focus. A hung HTTP request cannot stall recovery.
      const readRevision = JSON.stringify([readKey, reconcileMs ? Math.floor(Date.now() / reconcileMs) : 0, event?.type, event?.timeStamp])
      Promise.resolve().then(() => reconcileMs ? fetcherRef.current(key, { readRevision }) : fetcherRef.current(key))
        .then((next) => {
          if (!alive || request !== requested) return
          current = next ?? null
          retained.current = { key, value: current }
          if (cacheTag !== undefined) lastResolved.set(`${cacheTag}:${key}`, next ?? null)
          setValue(current)
          setError(null)
          setConfirmed(true)
          setConfirmedReadKey(readKey)
          clearTimeout(lease)
          if (leaseMs) lease = setTimeout(() => { if (alive) setConfirmed(false) }, leaseMs)
        })
        .catch((error: unknown) => {
          // A failed task read is not evidence that the task disappeared.
          if (!alive || request !== requested) return
          if (!polling) setValue(null)
          setConfirmed(false)
          setError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => { if (alive && request === requested) setLoading(false) })
    }
    fetch()
    const timer = polling ? setInterval(() => {
      if (reconcileMs || pollWhileRef.current?.(current)) fetch()
    }, reconcileMs ?? 2500) : undefined
    const offline = () => { requested++; setConfirmed(false); setError('Connection lost; freshness is unconfirmed.') }
    const visible = (event: Event) => {
      if (document.visibilityState === 'visible') { setConfirmed(false); fetch(event) }
    }
    if (reconcileMs) {
      window.addEventListener('focus', fetch)
      window.addEventListener('online', fetch)
      window.addEventListener('offline', offline)
      document.addEventListener('visibilitychange', visible)
    }
    return () => {
      alive = false
      clearInterval(timer)
      clearTimeout(lease)
      window.removeEventListener('focus', fetch)
      window.removeEventListener('online', fetch)
      window.removeEventListener('offline', offline)
      document.removeEventListener('visibilitychange', visible)
    }
    // `cacheTag` is constant per call site (a literal), so it needs no dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, polling, reconcileMs, leaseMs, refreshKey, refreshVersion])

  // Withdraw trust during the render receiving an invalidation/key change,
  // not one paint later when its replacement request starts.
  return { value: valueKey === key ? value : null, loading, error, confirmed: confirmed && confirmedReadKey === readKey, refresh }
}
