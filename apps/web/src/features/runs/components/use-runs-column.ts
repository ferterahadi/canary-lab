// RunsColumn's state: the four pending-confirmation slots, the menu/popover and
// compact-layout observers, the restart tracker, and the confirm handlers.
// Lifted out of the component verbatim so the column file is its markup; every
// binding comes back under its original name.
import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import { ApiError } from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import { useMcpPromo } from '@/shared/shell/McpPromoContext'
import { useRuns } from '../state/RunsContext'
import { useInvalidationKey } from '@/shared/state/invalidation'

// Below this width the column drops the per-run action buttons for a kebab menu.
const COMPACT_THRESHOLD_PX = 340

export function useRunsColumn({ runs, selectedRunId, onSelectRun, verifyOpen, onVerifyOpenChange }: {
  runs: RunIndexEntry[]
  selectedRunId: string | null
  onSelectRun: (runId: string | null) => void
  verifyOpen: boolean | undefined
  onVerifyOpenChange: ((open: boolean) => void) | undefined
}) {
  // An open Verify dialog refreshes its saved-config list live on
  // `verification-config-changed` (MCP/other-tab edits).
  const verificationRefreshKey = useInvalidationKey('verification')
  const [pendingPause, setPendingPause] = useState<RunIndexEntry | null>(null)
  const [pendingStop, setPendingStop] = useState<RunIndexEntry | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RunIndexEntry | null>(null)
  const [pendingCancelHeal, setPendingCancelHeal] = useState<RunIndexEntry | null>(null)
  const [openMenuRunId, setOpenMenuRunId] = useState<string | null>(null)
  const [runPopoverOpen, setRunPopoverOpen] = useState(false)
  // Controlled when App drives it from the route; uncontrolled otherwise.
  const [verifyDialogOpenInternal, setVerifyDialogOpenInternal] = useState(false)
  const verifyDialogOpen = verifyOpen ?? verifyDialogOpenInternal
  const setVerifyDialogOpen = useCallback((open: boolean) => {
    if (onVerifyOpenChange) onVerifyOpenChange(open)
    else setVerifyDialogOpenInternal(open)
  }, [onVerifyOpenChange])
  const [compact, setCompact] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { gatePromo } = useMcpPromo()

  // Single source of truth for action state — transient flags + per-run
  // errors come from the WS-backed RunsContext, not local state. Action
  // dispatchers (abort/delete/etc.) handle the API call + error capture
  // internally, so the component just decides WHEN to call them.
  const { transients, errors, abort, delete: deleteAction, pauseHeal, cancelHeal, clearError } = useRuns()

  // Retest ("restart") doesn't live in RunsContext because it's fast and the
  // run flips to `running`/`healing` via the WS update almost immediately.
  // Tracked locally so the row icon can show a spinner + disable until the
  // POST returns.
  const [restartingIds, setRestartingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [restartErrors, setRestartErrors] = useState<Record<string, string>>({})
  const onRestartRequest = useCallback(async (runId: string): Promise<void> => {
    if (restartingIds.has(runId)) return
    setRestartingIds((prev) => {
      const next = new Set(prev)
      next.add(runId)
      return next
    })
    setRestartErrors((prev) => {
      if (!(runId in prev)) return prev
      const next = { ...prev }
      delete next[runId]
      return next
    })
    try {
      await api.restartRun(runId)
    } catch (e: unknown) {
      const reason = e instanceof ApiError
        ? (e.body as { reason?: unknown })?.reason
        : undefined
      const msg = typeof reason === 'string'
        ? `Retest failed: ${reason}`
        : e instanceof Error ? e.message : 'Retest failed'
      setRestartErrors((prev) => ({ ...prev, [runId]: msg }))
    } finally {
      setRestartingIds((prev) => {
        const next = new Set(prev)
        next.delete(runId)
        return next
      })
    }
  }, [restartingIds])
  const clearRestartError = useCallback((runId: string): void => {
    setRestartErrors((prev) => {
      if (!(runId in prev)) return prev
      const next = { ...prev }
      delete next[runId]
      return next
    })
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCompact(entry.contentRect.width < COMPACT_THRESHOLD_PX)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Close the popover on any outside click.
  useEffect(() => {
    if (!openMenuRunId) return
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('[data-run-menu]')) return
      setOpenMenuRunId(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [openMenuRunId])

  // Same outside-click handler for the run-action popover (compact header).
  useEffect(() => {
    if (!runPopoverOpen) return
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('[data-run-launch-menu]')) return
      setRunPopoverOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [runPopoverOpen])

  // Close the popover automatically when leaving compact mode.
  useEffect(() => {
    if (!compact) setRunPopoverOpen(false)
  }, [compact])

  // Confirm-dialog handlers. Action mechanics (transient flag, API call,
  // error capture) live in RunsContext — these just dispatch and clear
  // the dialog. The post-success "row vanishes" beat is handled by the WS
  // `removed` frame patching the store.
  const confirmPause = async (): Promise<void> => {
    if (!pendingPause) return
    const target = pendingPause
    setPendingPause(null)
    await pauseHeal(target.runId)
  }

  const confirmStop = async (): Promise<void> => {
    if (!pendingStop) return
    const target = pendingStop
    setPendingStop(null)
    await abort(target.runId)
  }

  const confirmCancelHeal = async (): Promise<void> => {
    if (!pendingCancelHeal) return
    const target = pendingCancelHeal
    setPendingCancelHeal(null)
    await cancelHeal(target.runId)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const target = pendingDelete
    setPendingDelete(null)
    // Clear selection eagerly so the right pane doesn't 404 against the
    // runId we're about to remove. Safe even on failure — the user can
    // re-select; the row stays in the list until the WS `removed` frame
    // arrives.
    if (selectedRunId === target.runId) {
      onSelectRun(runs.find((r) => r.runId !== target.runId)?.runId ?? null)
    }
    await deleteAction(target.runId)
  }

  return { verificationRefreshKey, pendingPause, setPendingPause, pendingStop, setPendingStop, pendingDelete, setPendingDelete, pendingCancelHeal, setPendingCancelHeal, openMenuRunId, setOpenMenuRunId, runPopoverOpen, setRunPopoverOpen, verifyDialogOpen, setVerifyDialogOpen, compact, containerRef, gatePromo, transients, errors, abort, pauseHeal, cancelHeal, clearError, restartingIds, restartErrors, onRestartRequest, clearRestartError, confirmPause, confirmStop, confirmCancelHeal, confirmDelete }
}
