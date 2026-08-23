import { useEffect, useRef, useState } from 'react'
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
   *  is what every current caller renders — a missing card, not an error. */
  value: T | null
  /** True while a fetch is in flight, including refetches. Lets a caller hold a
   *  skeleton in place instead of flashing an empty state mid-refresh. */
  loading: boolean
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
  fetcher: (key: string) => Promise<T | null>,
  opts: {
    scope?: string
    /** Opt IN to the stale-then-fresh remount cache with a tag naming WHAT is
     *  fetched (e.g. `'ledger'`). Explicit because the topic alone cannot key
     *  it: two resources legitimately share a topic and a key (the ledger and
     *  the docs listing both live on `coverage` + the feature name), and an
     *  inferred key would hand one resource the other's value. Omit for a
     *  resource that must never paint stale. */
    cache?: string
  } = {},
): LiveResource<T> {
  const cacheKey = opts.cache !== undefined && key !== null ? `${opts.cache}:${key}` : null
  const [value, setValue] = useState<T | null>(() => (
    cacheKey !== null ? (lastResolved.get(cacheKey) as T | undefined) ?? null : null
  ))
  const [loading, setLoading] = useState(false)
  const version = useInvalidationKey(topic, opts.scope)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const cacheTag = opts.cache

  useEffect(() => {
    if (key === null) {
      setValue(null)
      setLoading(false)
      return
    }
    let alive = true
    // A key CHANGE (not a remount) paints the new key's cached value — or
    // nothing — immediately, so the pane never shows one stage's figures under
    // another stage's labels while the fetch is in flight.
    setValue(cacheTag !== undefined ? (lastResolved.get(`${cacheTag}:${key}`) as T | undefined) ?? null : null)
    setLoading(true)
    fetcherRef.current(key)
      .then((next) => {
        if (cacheTag !== undefined) lastResolved.set(`${cacheTag}:${key}`, next ?? null)
        if (alive) setValue(next ?? null)
      })
      .catch(() => { if (alive) setValue(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // `cacheTag` is constant per call site (a literal), so it needs no dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])

  return { value, loading }
}
