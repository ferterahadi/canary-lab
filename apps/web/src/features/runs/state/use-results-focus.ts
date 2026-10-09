import { useEffect, useMemo, useRef } from 'react'
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
 *
 * Returns where the focus stands: `unmatched` once the run's roster is
 * complete and still names no such test, so the view can say the link is
 * stale instead of opening nothing in silence.
 */
export function useResultsFocus(
  runId: string | null,
  detail: Pick<RunDetail, 'playbackEvents' | 'playbackIdentity' | 'summary'> | null | undefined,
  focus: ResultsFocus,
  onResolve: (caseKey: string) => void,
): 'none' | 'pending' | 'resolved' | 'unmatched' {
  const resolved = useRef<string | null>(null)
  const { test, testId, testLocation, request } = focus
  const focusKey = JSON.stringify([runId, test ?? null, testId ?? null, testLocation ?? null, request ?? null])
  const resolve = useRef(onResolve)
  resolve.current = onResolve
  const caseKey = useMemo(
    () => (test && detail ? focusedCaseKey(detail, { name: test, id: testId, location: testLocation }) : undefined),
    [test, testId, testLocation, detail],
  )
  useEffect(() => {
    if (!caseKey || resolved.current === focusKey) return
    resolved.current = focusKey
    resolve.current(caseKey)
  }, [focusKey, caseKey])
  if (!test) return 'none'
  if (caseKey) return 'resolved'
  return detail?.summary?.complete ? 'unmatched' : 'pending'
}
