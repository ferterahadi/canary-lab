import { useEffect, useRef } from 'react'
import type { RunDetail } from '@shared/run-detail'
import { focusedCaseKey } from '../utils/results-fixes'

/** `request` distinguishes a repeated click on the same test, so it re-opens a
 *  row the reader collapsed; absent on a cold load from the URL. */
export interface ResultsFocus { test?: string; testId?: string; testLocation?: string; request?: number }

/**
 * Opens the case a routed or clicked test points at, once the run has recorded
 * it — playback events can arrive after the link does. Each focus resolves
 * once, so a reader who then collapses or switches cases is not pulled back by
 * the next pushed update; a new focus (a second click) resolves again.
 */
export function useResultsFocus(
  runId: string | null,
  detail: Pick<RunDetail, 'playbackEvents' | 'playbackIdentity' | 'summary'> | null | undefined,
  focus: ResultsFocus,
  onResolve: (caseKey: string) => void,
): void {
  const resolved = useRef<string | null>(null)
  const { test, testId, testLocation, request } = focus
  const focusKey = JSON.stringify([runId, test ?? null, testId ?? null, testLocation ?? null, request ?? null])
  const resolve = useRef(onResolve)
  resolve.current = onResolve
  useEffect(() => {
    if (!test || !detail || resolved.current === focusKey) return
    const caseKey = focusedCaseKey(detail, { name: test, id: testId, location: testLocation })
    if (!caseKey) return
    resolved.current = focusKey
    resolve.current(caseKey)
  }, [focusKey, test, testId, testLocation, detail])
}
