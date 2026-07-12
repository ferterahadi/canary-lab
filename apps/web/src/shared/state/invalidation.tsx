import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  EMPTY_INVALIDATION,
  bumpInvalidation,
  readInvalidation,
  type InvalidationState,
  type InvalidationTopic,
} from './invalidation-bus'

// Two contexts on purpose: the dispatch (`invalidate`) is reference-stable so
// the WS handler and other publishers never re-render when a version bumps,
// while the state map lives in its own context so only the fetch-owning leaves
// that read `useInvalidationKey` re-render. This mirrors the classic
// state/dispatch context split and keeps the bump cheap.

interface InvalidationDispatch {
  invalidate: (topic: InvalidationTopic, scope?: string) => void
}

const InvalidationDispatchContext = createContext<InvalidationDispatch | null>(null)
const InvalidationStateContext = createContext<InvalidationState | null>(null)

export function InvalidationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<InvalidationState>(EMPTY_INVALIDATION)

  const invalidate = useCallback((topic: InvalidationTopic, scope?: string): void => {
    setState((s) => bumpInvalidation(s, topic, scope))
  }, [])

  // Stable across bumps — `invalidate` never changes identity.
  const dispatch = useMemo<InvalidationDispatch>(() => ({ invalidate }), [invalidate])

  return (
    <InvalidationDispatchContext.Provider value={dispatch}>
      <InvalidationStateContext.Provider value={state}>
        {children}
      </InvalidationStateContext.Provider>
    </InvalidationDispatchContext.Provider>
  )
}

/** Publisher side — call `invalidate(topic, scope?)` to bump a surface's
 *  version so its fetcher refetches. Reference-stable; safe as an effect dep. */
export function useInvalidation(): InvalidationDispatch {
  const value = useContext(InvalidationDispatchContext)
  if (!value) throw new Error('useInvalidation must be used inside InvalidationProvider')
  return value
}

/** Consumer side — subscribe to a surface's version. Use it as a `useEffect`
 *  dep exactly where a `refreshKey` prop used to sit; it changes only when that
 *  topic (+ scope) is invalidated, so it triggers a refetch and nothing else.
 *
 *  With no provider above it (an isolated component unit test) this reads 0 —
 *  "no bus wired, so never invalidated" — which matches the `useState(0)` the
 *  refresh keys defaulted to, so leaves stay mountable without the provider. */
export function useInvalidationKey(topic: InvalidationTopic, scope?: string): number {
  const state = useContext(InvalidationStateContext)
  return state ? readInvalidation(state, topic, scope) : 0
}
