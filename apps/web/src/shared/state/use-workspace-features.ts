import { useCallback, useEffect, useRef } from 'react'
import { listFeatures } from '../api/client'
import type { Feature } from '../api/types'
import { useLiveResource } from './use-live-resource'

type SelectionRequest = { initial: true } | { initial: false; preferredFeature?: string | null }

export function useWorkspaceFeatures(
  onInitialFeatures: (features: readonly Feature[]) => void,
  onFeaturesRefreshed: (features: readonly Feature[], preferredFeature?: string | null) => void,
) {
  const selectionRequest = useRef<SelectionRequest>({ initial: true })
  const callbacks = useRef({ onInitialFeatures, onFeaturesRefreshed })
  callbacks.current = { onInitialFeatures, onFeaturesRefreshed }

  const { value: snapshot, refresh } = useLiveResource('features', 'workspace', async () => {
    const selection = selectionRequest.current
    return { features: await listFeatures(), selection }
  }, { reconcileMs: 10_000 })

  // Reconcile selection only after the live reader accepts a response. Doing
  // this inside the fetcher would let a superseded request restore a deleted
  // suite or override a newer rename. Keep the preference through failed reads.
  useEffect(() => {
    if (!snapshot) return
    if (snapshot.selection.initial) callbacks.current.onInitialFeatures(snapshot.features)
    else callbacks.current.onFeaturesRefreshed(snapshot.features, snapshot.selection.preferredFeature)
    // A callback may itself request another refresh. Consume only the request
    // this snapshot answered; later recovery must not replay an old preference.
    if (selectionRequest.current === snapshot.selection) selectionRequest.current = { initial: false }
  }, [snapshot])

  const refreshFeatures = useCallback((preferredFeature?: string | null): void => {
    selectionRequest.current = { initial: false, preferredFeature }
    refresh()
  }, [refresh])

  return { features: snapshot?.features ?? [], refreshFeatures }
}
